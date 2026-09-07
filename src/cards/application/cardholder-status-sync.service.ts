import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WebhookDeliveryService } from '../../payments/infrastructure/webhooks/webhook-delivery.service';
import { CardCapability } from '../domain/card-capability.enum';
import { supportsCapability } from '../domain/card-issuer-guards';
import { CardEventSource } from '../domain/card-event-source.enum';
import { CardholderStatus } from '../domain/cardholder-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardholderEnrolmentEntity } from '../infrastructure/persistence/cardholder-enrolment.entity';
import { CardholderEventEntity } from '../infrastructure/persistence/cardholder-event.entity';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';

/**
 * The enrolment as it now stands, and whether a provider was actually asked.
 * An issuer that reports no person-level status is skipped, and the two cases
 * are indistinguishable from the row alone.
 */
export interface CardholderStatusSyncResult {
  enrolment: CardholderEnrolmentEntity;
  queried: boolean;
}

const TERMINAL_STATUSES = new Set<CardholderStatus>([
  CardholderStatus.APPROVED,
  CardholderStatus.COMPLIANCE_DECLINE,
  CardholderStatus.ADMIN_DECLINE,
  CardholderStatus.ERROR,
]);

@Injectable()
export class CardholderStatusSyncService {
  constructor(
    @InjectRepository(CardholderEnrolmentEntity)
    private readonly enrolmentRepository: Repository<CardholderEnrolmentEntity>,
    @InjectRepository(CardholderEventEntity)
    private readonly eventRepository: Repository<CardholderEventEntity>,
    @InjectRepository(CardholderEntity)
    private readonly cardholderRepository: Repository<CardholderEntity>,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
    private readonly webhookDeliveryService: WebhookDeliveryService,
  ) {}

  /**
   * Queries the provider for this enrolment's current status and persists any
   * change. `queried` is false when no provider was asked, so a caller
   * publishing the status cannot present a stored value as a live one.
   */
  async syncOne(
    enrolment: CardholderEnrolmentEntity,
    source: CardEventSource,
  ): Promise<CardholderStatusSyncResult> {
    if (!enrolment.providerCardholderId) {
      return { enrolment, queried: false };
    }

    const adapter = this.cardIssuerRegistry.resolve(enrolment.providerKey);
    // Skipped rather than thrown: this runs from the reconcile sweep across
    // every pending enrolment, so one provider that cannot answer must not
    // abort the pass for the others. Same shape as the guard above and as
    // ReconcileCardBalancesUseCase. Skipping leaves the stored status alone,
    // which is the only safe answer for an issuer holding no person to ask
    // about.
    if (!supportsCapability(adapter, CardCapability.CARDHOLDER_STATUS)) {
      return { enrolment, queried: false };
    }

    const result = await adapter.queryCardholderStatus(
      enrolment.providerCardholderId,
      {},
    );

    if (result.status === enrolment.status) {
      return { enrolment, queried: true };
    }

    const previousStatus = enrolment.status;
    enrolment.status = result.status;
    const saved = await this.enrolmentRepository.save(enrolment);

    await this.eventRepository.save(
      this.eventRepository.create({
        cardholderEnrolmentId: saved.id,
        fromStatus: previousStatus,
        toStatus: result.status,
        source,
      }),
    );

    if (TERMINAL_STATUSES.has(result.status)) {
      await this.announce(saved, result.status);
    }

    return { enrolment: saved, queried: true };
  }

  /**
   * Tells the partner an issuer has decided. The event is addressed by the
   * person and carries the issuer, because one person can be pending at one
   * issuer and approved at another.
   */
  private async announce(
    enrolment: CardholderEnrolmentEntity,
    status: CardholderStatus,
  ): Promise<void> {
    const cardholder = await this.cardholderRepository.findOne({
      where: { id: enrolment.cardholderId },
    });
    if (!cardholder) return;

    await this.webhookDeliveryService.enqueueForCardholder(
      cardholder.id,
      cardholder.partnerId,
      'cardholder.status_updated',
      {
        eventType: 'cardholder.status_updated',
        cardholderPublicId: cardholder.publicId,
        providerKey: enrolment.providerKey,
        status,
        occurredAt: new Date().toISOString(),
      },
    );
  }
}
