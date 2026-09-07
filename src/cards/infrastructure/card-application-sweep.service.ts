import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ReconcileNotActivatedCardsUseCase } from '../application/reconcile-not-activated-cards.usecase';
import { ResolveCardApplicationsUseCase } from '../application/resolve-card-applications.usecase';

/** The registry key this sweep's timer is held under. */
const INTERVAL_NAME = 'card-application-sweep';

/**
 * Drives both halves of watching an asynchronous card opening, on one timer:
 * one pass asks what became of an acknowledged application, the other watches
 * the card it produced reach usable.
 */
@Injectable()
export class CardApplicationSweepService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(CardApplicationSweepService.name);

  /** Which passes are running — see `sweep` for why it is per pass. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly resolveCardApplicationsUseCase: ResolveCardApplicationsUseCase,
    private readonly reconcileNotActivatedCardsUseCase: ReconcileNotActivatedCardsUseCase,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    // `sweep` stays callable either way — this only decides whether a timer
    // calls it. Off under test, where one application per spec file means one
    // copy of this pass per spec file, all against the same schema.
    if (!this.configService.getOrThrow<boolean>('SCHEDULED_SWEEPS_ENABLED')) {
      this.logger.log('Card application sweep disabled — no timer registered');
      return;
    }

    const seconds = this.configService.getOrThrow<number>(
      'CARD_APPLICATION_SWEEP_INTERVAL_SECONDS',
    );

    const timer = setInterval(() => {
      // The timer's callback cannot be awaited, so a rejection here would be an
      // unhandled one. Each pass already isolates its own rows; this catches
      // what is left — the query itself failing, which is the database being
      // away and not something a pass can do anything about.
      void this.sweep();
    }, seconds * 1000);

    this.schedulerRegistry.addInterval(INTERVAL_NAME, timer);
    this.logger.log(`Card application sweep running every ${seconds}s`);
  }

  onModuleDestroy(): void {
    if (this.schedulerRegistry.doesExist('interval', INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(INTERVAL_NAME);
    }
  }

  /**
   * Both passes per tick, started together: run in sequence, a full batch of
   * each outruns the interval they share.
   *
   * They are not independent — the result lookup writes the `card` rows the
   * status read selects — and that is safe only because the write is
   * transactional. Move it out and one transition records two `card_event`
   * rows. A flag each, so one pass outrunning the interval skips its own next
   * turn and not the other's.
   */
  async sweep(): Promise<void> {
    await Promise.all([
      this.runPass('result lookup', () =>
        this.resolveCardApplicationsUseCase.execute(),
      ),
      this.runPass('card status read', () =>
        this.reconcileNotActivatedCardsUseCase.execute(),
      ),
    ]);
  }

  private async runPass(
    name: string,
    pass: () => Promise<void>,
  ): Promise<void> {
    if (this.inFlight.has(name)) {
      this.logger.warn(
        `Skipping this card application sweep (${name}) — the previous pass is still running. It will be retried on the next tick; consider a longer CARD_APPLICATION_SWEEP_INTERVAL_SECONDS or a smaller batch.`,
      );
      return;
    }

    this.inFlight.add(name);
    try {
      await pass();
    } catch (error) {
      this.logger.error(
        `Card application sweep (${name}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      // In a `finally`, or a pass that threw wedges itself for the life of the
      // process.
      this.inFlight.delete(name);
    }
  }
}
