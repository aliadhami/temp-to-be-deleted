import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { ReconcileNotActivatedCardsUseCase } from '../application/reconcile-not-activated-cards.usecase';
import { ResolveCardApplicationsUseCase } from '../application/resolve-card-applications.usecase';
import { CardApplicationSweepService } from './card-application-sweep.service';

/**
 * The repository's first dynamically-registered interval, and the reason it is
 * dynamic is that its cadence comes from configuration — so the cadence being
 * read, the timer being registered, and the timer being torn down are exactly
 * what a regression would silently drop.
 */
describe('CardApplicationSweepService', () => {
  let service: CardApplicationSweepService;
  let resolveApplications: { execute: jest.Mock };
  let reconcileCards: { execute: jest.Mock };
  let schedulerRegistry: {
    addInterval: jest.Mock;
    deleteInterval: jest.Mock;
    doesExist: jest.Mock;
  };
  let configService: { getOrThrow: jest.Mock };
  let warnSpy: jest.SpyInstance;

  const INTERVAL_SECONDS = 90;

  /** Lets every already-resolved pass run its `finally` and release its flag. */
  const settle = async (): Promise<void> => {
    for (let tick = 0; tick < 4; tick++) await Promise.resolve();
  };

  beforeEach(async () => {
    jest.useFakeTimers();

    resolveApplications = { execute: jest.fn().mockResolvedValue(undefined) };
    reconcileCards = { execute: jest.fn().mockResolvedValue(undefined) };
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
        CardApplicationSweepService,
        {
          provide: ResolveCardApplicationsUseCase,
          useValue: resolveApplications,
        },
        {
          provide: ReconcileNotActivatedCardsUseCase,
          useValue: reconcileCards,
        },
        { provide: SchedulerRegistry, useValue: schedulerRegistry },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(CardApplicationSweepService);
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
        'CARD_APPLICATION_SWEEP_INTERVAL_SECONDS',
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

    it('runs at the configured cadence rather than a hardcoded one', () => {
      service.onModuleInit();

      expect(configService.getOrThrow).toHaveBeenCalledWith(
        'CARD_APPLICATION_SWEEP_INTERVAL_SECONDS',
      );
      // Registered rather than left to a decorator, which is what makes the
      // value above reachable at all.
      expect(schedulerRegistry.addInterval).toHaveBeenCalledTimes(1);
    });

    it('registers one timer for both passes', () => {
      service.onModuleInit();

      // Two timers would be two cadences and two batch budgets against one
      // issuer, which is the thing sharing this service avoids.
      expect(schedulerRegistry.addInterval).toHaveBeenCalledTimes(1);
    });

    it('does not sweep before the first interval elapses', () => {
      service.onModuleInit();

      jest.advanceTimersByTime(INTERVAL_SECONDS * 1000 - 1);

      // A long cadence is what keeps this sweep from calling a live issuer
      // during a test run, so "the first tick waits" is load-bearing.
      expect(resolveApplications.execute).not.toHaveBeenCalled();
      expect(reconcileCards.execute).not.toHaveBeenCalled();
    });

    it('sweeps once the interval elapses', () => {
      service.onModuleInit();

      jest.advanceTimersByTime(INTERVAL_SECONDS * 1000);

      expect(resolveApplications.execute).toHaveBeenCalledTimes(1);
    });

    it('deletes its timer on shutdown', () => {
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

  describe('both passes', () => {
    it('runs both passes on one tick', async () => {
      await service.sweep();

      expect(resolveApplications.execute).toHaveBeenCalledTimes(1);
      expect(reconcileCards.execute).toHaveBeenCalledTimes(1);
    });

    it('does not make the second pass wait for the first', async () => {
      // Run in sequence, a full batch of each costs more than the interval
      // they share, and every second tick is then dropped.
      let releaseFirst = (): void => {};
      resolveApplications.execute.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve;
          }),
      );

      const sweeping = service.sweep();
      await Promise.resolve();

      expect(reconcileCards.execute).toHaveBeenCalledTimes(1);

      releaseFirst();
      await sweeping;
    });

    it('still reads card statuses when the result lookup threw', async () => {
      // The two read disjoint sets, so a failure resolving new applications
      // says nothing about the cards already opened. Skipping the second would
      // stop a card ever being seen to activate over an unrelated fault.
      resolveApplications.execute.mockRejectedValueOnce(
        new Error('issuer is away'),
      );

      await service.sweep();

      expect(reconcileCards.execute).toHaveBeenCalledTimes(1);
    });

    it('swallows a failed pass rather than rejecting into the timer', async () => {
      reconcileCards.execute.mockRejectedValueOnce(new Error('database gone'));

      // The timer callback cannot be awaited, so a rejection escaping here
      // would be an unhandled one.
      await expect(service.sweep()).resolves.toBeUndefined();
    });
  });

  describe('one pass at a time', () => {
    it('skips a tick while the previous pass is still running', async () => {
      // A pass makes one live call per row, so it can outrun its own interval.
      // Two overlapping passes would both read the same row and both act on
      // it — writing the card twice and appending two events for one
      // transition.
      let release = (): void => {};
      resolveApplications.execute.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );

      const first = service.sweep();
      await service.sweep();

      expect(resolveApplications.execute).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('previous pass is still running'),
      );

      release();
      await first;
    });

    it('lets the other pass keep its turn while one is skipped', async () => {
      // One flag stopped the card status read over a slow result lookup, so a
      // card could not be seen to activate while applications were backed up.
      let release = (): void => {};
      resolveApplications.execute.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );

      const first = service.sweep();
      // A pass releases its flag a microtask after it settles, so the second
      // tick has to come after that rather than in the same turn.
      await settle();
      await service.sweep();

      expect(resolveApplications.execute).toHaveBeenCalledTimes(1);
      expect(reconcileCards.execute).toHaveBeenCalledTimes(2);

      release();
      await first;
    });

    it('accepts the next pass once the previous one finishes', async () => {
      await service.sweep();
      await service.sweep();

      expect(resolveApplications.execute).toHaveBeenCalledTimes(2);
      expect(reconcileCards.execute).toHaveBeenCalledTimes(2);
    });

    it('is not wedged by a pass that threw', async () => {
      // Released in a `finally`, so one failure cannot stop the sweep for the
      // lifetime of the process.
      reconcileCards.execute.mockRejectedValueOnce(new Error('database gone'));

      await service.sweep();
      await service.sweep();

      expect(reconcileCards.execute).toHaveBeenCalledTimes(2);
    });
  });
});
