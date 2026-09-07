import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { ReconcileCardholdersUseCase } from '../application/reconcile-cardholders.usecase';

@Injectable()
export class ReconcileCardholdersSweepService {
  private readonly logger = new Logger(ReconcileCardholdersSweepService.name);

  constructor(
    private readonly reconcileCardholdersUseCase: ReconcileCardholdersUseCase,
    private readonly configService: ConfigService,
  ) {}

  /**
   * The timer, kept separate from the pass so `sweep` stays directly callable
   * whether or not the timer is doing anything. `@Interval` registers at
   * bootstrap and cannot be made conditional, so the flag is read here.
   */
  @Interval(60_000) // every 60 seconds — Axys review is minutes-to-hours, no need for tighter polling
  async tick(): Promise<void> {
    if (!this.configService.getOrThrow<boolean>('SCHEDULED_SWEEPS_ENABLED')) {
      return;
    }
    await this.sweep();
  }

  async sweep(): Promise<void> {
    await this.reconcileCardholdersUseCase.execute();
  }
}
