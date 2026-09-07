import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ReconcileCardBalancesUseCase } from '../application/reconcile-card-balances.usecase';

/** The registry key this sweep's timer is held under. */
const INTERVAL_NAME = 'card-balance-sweep';

/**
 * Drives the pass that re-reads what an issuer says a card holds. Registered
 * through `SchedulerRegistry` rather than with `@Interval`, and the change was
 * forced by a second issuer declaring the capability.
 */
@Injectable()
export class ReconcileCardsSweepService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ReconcileCardsSweepService.name);

  /** Whether a pass is running — see `sweep` for why a timer needs this. */
  private inFlight = false;

  constructor(
    private readonly reconcileCardBalancesUseCase: ReconcileCardBalancesUseCase,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    // `sweep` stays callable either way — this only decides whether a timer
    // calls it. Off under test, where one application per spec file means one
    // copy of this pass per spec file, all against the same schema.
    if (!this.configService.getOrThrow<boolean>('SCHEDULED_SWEEPS_ENABLED')) {
      this.logger.log('Card balance sweep disabled — no timer registered');
      return;
    }

    const seconds = this.configService.getOrThrow<number>(
      'CARD_BALANCE_SWEEP_INTERVAL_SECONDS',
    );

    const timer = setInterval(() => {
      // The timer's callback cannot be awaited, so a rejection here would be an
      // unhandled one. The pass already isolates its own rows; this catches
      // what is left — the query itself failing, which is the database being
      // away and not something a pass can do anything about.
      void this.sweep();
    }, seconds * 1000);

    this.schedulerRegistry.addInterval(INTERVAL_NAME, timer);
    this.logger.log(`Card balance sweep running every ${seconds}s`);
  }

  onModuleDestroy(): void {
    if (this.schedulerRegistry.doesExist('interval', INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(INTERVAL_NAME);
    }
  }

  /**
   * One pass, and never two at once. A timer does not wait for its own
   * callback, and a pass makes one live call per row, so a full batch against
   * a slow issuer takes far longer than any sensible cadence.
   */
  async sweep(): Promise<void> {
    if (this.inFlight) {
      this.logger.warn(
        'Skipping this card balance sweep — the previous pass is still running. It will be retried on the next tick; consider a longer CARD_BALANCE_SWEEP_INTERVAL_SECONDS or a smaller batch.',
      );
      return;
    }

    this.inFlight = true;
    try {
      await this.reconcileCardBalancesUseCase.execute();
    } catch (error) {
      this.logger.error(
        `Card balance sweep failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      // In a `finally`, so a pass that threw cannot wedge the sweep for the
      // lifetime of the process.
      this.inFlight = false;
    }
  }
}
