import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { ResolveCardDepositsUseCase } from '../application/resolve-card-deposits.usecase';
import { CardDepositSweepService } from './card-deposit-sweep.service';

/**
 * A dynamically-registered interval, for the reason the card application sweep
 * beside it is one: its cadence comes from configuration, so the cadence being
 * read, the timer being registered and the timer being torn down are exactly
 * what a regression would silently drop.
 */
describe('CardDepositSweepService', () => {
  let service: CardDepositSweepService;
  let resolveDeposits: { execute: jest.Mock };
  let schedulerRegistry: {
    addInterval: jest.Mock;
    deleteInterval: jest.Mock;
    doesExist: jest.Mock;
  };
  let configService: { getOrThrow: jest.Mock };
  let warnSpy: jest.SpyInstance;

  const INTERVAL_SECONDS = 90;

  beforeEach(async () => {
    jest.useFakeTimers();

    resolveDeposits = { execute: jest.fn().mockResolvedValue(undefined) };
    schedulerRegistry = {
      addInterval: jest.fn(),
      deleteInterval: jest.fn(),
      doesExist: jest.fn().mockReturnValue(true),
    };
    configService = {
      getOrThrow: jest.fn((key: string) =>
        key === 'SCHEDULED_SWEEPS_ENABLED' ? true : INTERVAL_SECONDS,
      ),
    };

    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CardDepositSweepService,
        { provide: ResolveCardDepositsUseCase, useValue: resolveDeposits },
        { provide: SchedulerRegistry, useValue: schedulerRegistry },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(CardDepositSweepService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('registration', () => {
    it('registers no timer when scheduled sweeps are switched off', () => {
      // The e2e run boots one application per spec file against one shared
      // schema, so a registered timer there is one copy of this pass per spec
      // file, all rewriting each other's fixtures.
      configService.getOrThrow.mockImplementation((key: string) =>
        key === 'SCHEDULED_SWEEPS_ENABLED' ? false : INTERVAL_SECONDS,
      );

      service.onModuleInit();

      expect(schedulerRegistry.addInterval).not.toHaveBeenCalled();
      // Read before the interval, so a deployment that switches the sweep off
      // need not also supply a cadence for it.
      expect(configService.getOrThrow).not.toHaveBeenCalledWith(
        'CARD_DEPOSIT_SWEEP_INTERVAL_SECONDS',
      );
    });

    it('leaves the pass callable while the timer is off', async () => {
      // Every e2e spec that covers a sweep calls this directly; switching the
      // timer off must not switch the pass off with it.
      configService.getOrThrow.mockImplementation((key: string) =>
        key === 'SCHEDULED_SWEEPS_ENABLED' ? false : INTERVAL_SECONDS,
      );
      service.onModuleInit();

      await service.sweep();

      expect(schedulerRegistry.addInterval).not.toHaveBeenCalled();
    });

    it('runs at its own configured cadence, not a shared one', () => {
      service.onModuleInit();

      // Its own variable is the point: one number would describe two budgets
      // gated by two different capabilities.
      expect(configService.getOrThrow).toHaveBeenCalledWith(
        'CARD_DEPOSIT_SWEEP_INTERVAL_SECONDS',
      );
      expect(schedulerRegistry.addInterval).toHaveBeenCalledTimes(1);
    });

    it('does not sweep before the first interval elapses', () => {
      service.onModuleInit();

      jest.advanceTimersByTime(INTERVAL_SECONDS * 1000 - 1);

      // A long cadence is what keeps this sweep from calling a live issuer
      // during a test run, so "the first tick waits" is load-bearing.
      expect(resolveDeposits.execute).not.toHaveBeenCalled();
    });

    it('sweeps once the interval elapses', () => {
      service.onModuleInit();

      jest.advanceTimersByTime(INTERVAL_SECONDS * 1000);

      expect(resolveDeposits.execute).toHaveBeenCalledTimes(1);
    });

    it('deletes its timer on shutdown', () => {
      // Left registered, the closure outlives the module and fires against a
      // closed connection.
      service.onModuleInit();
      service.onModuleDestroy();

      expect(schedulerRegistry.deleteInterval).toHaveBeenCalledTimes(1);
    });

    it('does not delete a timer it never registered', () => {
      schedulerRegistry.doesExist.mockReturnValue(false);

      service.onModuleDestroy();

      expect(schedulerRegistry.deleteInterval).not.toHaveBeenCalled();
    });
  });

  describe('the pass', () => {
    it('swallows a failed pass rather than rejecting into the timer', async () => {
      // The timer callback cannot be awaited, so a rejection escaping here
      // would be an unhandled one.
      resolveDeposits.execute.mockRejectedValueOnce(new Error('database gone'));

      await expect(service.sweep()).resolves.toBeUndefined();
    });
  });

  describe('one pass at a time', () => {
    it('skips a tick while the previous pass is still running', async () => {
      // A pass makes one live call per row, so it can outrun its own interval.
      // Two overlapping passes would both read the same deposit before either
      // had written its outcome, and both would announce one settlement.
      let release = (): void => {};
      resolveDeposits.execute.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );

      const first = service.sweep();
      await service.sweep();

      expect(resolveDeposits.execute).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('previous pass is still running'),
      );

      release();
      await first;
    });

    it('accepts the next pass once the previous one finishes', async () => {
      await service.sweep();
      await service.sweep();

      expect(resolveDeposits.execute).toHaveBeenCalledTimes(2);
    });

    it('is not wedged by a pass that threw', async () => {
      // Released in a `finally`, so one failure cannot stop the sweep for the
      // lifetime of the process.
      resolveDeposits.execute.mockRejectedValueOnce(new Error('database gone'));

      await service.sweep();
      await service.sweep();

      expect(resolveDeposits.execute).toHaveBeenCalledTimes(2);
    });
  });
});
