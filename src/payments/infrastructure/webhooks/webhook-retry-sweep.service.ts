import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { WebhookDeliveryService } from './webhook-delivery.service';

@Injectable()
export class WebhookRetrySweepService {
  constructor(
    private readonly webhookDeliveryService: WebhookDeliveryService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * The timer, kept separate from the pass so `sweep` stays directly callable
   * whether or not the timer is doing anything. `@Interval` registers at
   * bootstrap and cannot be made conditional, so the flag is read here.
   */
  @Interval(30_000)
  async tick(): Promise<void> {
    if (!this.configService.getOrThrow<boolean>('SCHEDULED_SWEEPS_ENABLED')) {
      return;
    }
    await this.sweep();
  }

  async sweep(): Promise<void> {
    await this.webhookDeliveryService.processDueDeliveries();
  }
}
