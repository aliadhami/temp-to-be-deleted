import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { ReconcileCardBalancesUseCase } from '../application/reconcile-card-balances.usecase';
import { ReconcileCardsSweepService } from './reconcile-cards-sweep.service';

/**
 * A dynamically-registered interval, and this sweep is the one that had to
 * become one rather than being built that way.
 */
describe('ReconcileCardsSweepService', () => {
  let service: ReconcileCardsSweepService;
  let reconcileBalances: { execute: jest.Mock };
  let schedulerRegistry: {
    addInterval: jest.Mock;
    deleteInterval: jest.Mock;
    doesExist: jest.Mock;
  };
  let configService: { getOrThrow: jest.Mock };
  let warnSpy: jest.SpyInstance;

  const INTERVAL_SECONDS = 120;

  beforeEach(async () => {
    jest.useFakeTimers();

    reconcileBalances = { execute: jest.fn().mockResolvedValue(undefined) };
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
        ReconcileCardsSweepService,
        {
          provide: ReconcileCardBalancesUseCase,
          useValue: reconcileBalances,
        },
        { provide: SchedulerRegistry, useValue: schedulerRegistry },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(ReconcileCardsSweepService);
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
        'CARD_BALANCE_SWEEP_INTERVAL_SECONDS',
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

    it('runs at its own configured cadence', () => {
      service.onModuleInit();

      // Its own variable rather than one shared with the sweeps beside it: the
      // three are gated by different capabilities, so a deployment can run an
      // issuer that reports balances and opens cards synchronously, or the
      // reverse.
      expect(configService.getOrThrow).toHaveBeenCalledWith(
        'CARD_BALANCE_SWEEP_INTERVAL_SECONDS',
      );
      expect(schedulerRegistry.addInterval).toHaveBeenCalledTimes(1);
    });

    it('does not sweep before the first interval elapses', () => {
      service.onModuleInit();

      jest.advanceTimersByTime(INTERVAL_SECONDS * 1000 - 1);

      // A long cadence is what keeps this sweep from calling a live issuer
      // during a test run, so "the first tick waits" is load-bearing.
      expect(reconcileBalances.execute).not.toHaveBeenCalled();
    });

    it('sweeps once the interval elapses', () => {
      service.onModuleInit();

      jest.advanceTimersByTime(INTERVAL_SECONDS * 1000);

      expect(reconcileBalances.execute).toHaveBeenCalledTimes(1);
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
      reconcileBalances.execute.mockRejectedValueOnce(
        new Error('database gone'),
      );

      await expect(service.sweep()).resolves.toBeUndefined();
    });
  });

  describe('one pass at a time', () => {
    it('skips a tick while the previous pass is still running', async () => {
      // A pass makes one live call per row against the transport's own
      // timeout, so it can outrun its interval by a wide margin. Two
      // overlapping passes would ask one issuer twice for the same answer and
      // race each other writing the balance columns.
      let release = (): void => {};
      reconcileBalances.execute.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );

      const first = service.sweep();
      await service.sweep();

      expect(reconcileBalances.execute).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('previous pass is still running'),
      );

      release();
      await first;
    });

    it('accepts the next pass once the previous one finishes', async () => {
      await service.sweep();
      await service.sweep();

      expect(reconcileBalances.execute).toHaveBeenCalledTimes(2);
    });

    it('is not wedged by a pass that threw', async () => {
      // Released in a `finally`, so one failure cannot stop the sweep for the
      // lifetime of the process.
      reconcileBalances.execute.mockRejectedValueOnce(
        new Error('database gone'),
      );

      await service.sweep();
      await service.sweep();

      expect(reconcileBalances.execute).toHaveBeenCalledTimes(2);
    });
  });
});
