import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac } from 'node:crypto';
import { LessThanOrEqual, Repository } from 'typeorm';
import { PartnerEntity } from '../../../partners/persistence/partner.entity';
import { CredentialEncryptionService } from '../../../shared/crypto/credential-encryption.service';
import { PaymentStatus } from '../../domain/payment-status.enum';
import { PaymentTransactionEntity } from '../persistence/payment-transaction.entity';
import {
  WebhookDeliveryEntity,
  WebhookDeliveryStatus,
} from './webhook-delivery.entity';

const MAX_ATTEMPTS = 5;
const BACKOFF_MINUTES = [1, 5, 30, 120]; // wait before attempts 2, 3, 4, 5 respectively
const DELIVERY_TIMEOUT_MS = 10_000;

@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  constructor(
    @InjectRepository(WebhookDeliveryEntity)
    private readonly deliveryRepository: Repository<WebhookDeliveryEntity>,
    @InjectRepository(PartnerEntity)
    private readonly partnerRepository: Repository<PartnerEntity>,
    private readonly encryptionService: CredentialEncryptionService,
  ) {}

  /** Called from ProcessGatewayResultUseCase once a transaction reaches a terminal status. No-op if the partner has no webhook configured. */
  async enqueueForTransaction(
    transaction: PaymentTransactionEntity,
    status: PaymentStatus,
  ): Promise<void> {
    if (!transaction.partnerId) return;

    const partner = await this.partnerRepository.findOne({
      where: { id: transaction.partnerId },
    });
    if (!partner?.webhookUrl) return;

    const row = this.deliveryRepository.create({
      partnerId: partner.id,
      transactionId: transaction.id,
      eventType: 'payment.status_updated',
      payload: {
        eventType: 'payment.status_updated',
        paymentPublicId: transaction.publicId,
        gatewayKey: transaction.gatewayKey,
        status,
        referenceNumber: transaction.referenceNumber,
        amount: transaction.amount,
        currency: transaction.currency,
        occurredAt: new Date().toISOString(),
      },
      status: WebhookDeliveryStatus.PENDING,
      attemptCount: 0,
      nextAttemptAt: new Date(),
    });
    await this.deliveryRepository.save(row);
  }
  async enqueueForCardholder(
    cardholderId: string,
    partnerId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const partner = await this.partnerRepository.findOne({
      where: { id: partnerId },
    });
    if (!partner?.webhookUrl) return;

    const row = this.deliveryRepository.create({
      partnerId: partner.id,
      cardholderId,
      eventType,
      payload,
      status: WebhookDeliveryStatus.PENDING,
      attemptCount: 0,
      nextAttemptAt: new Date(),
    });
    await this.deliveryRepository.save(row);
  }

  async enqueueForCard(
    cardId: string,
    partnerId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const partner = await this.partnerRepository.findOne({
      where: { id: partnerId },
    });
    if (!partner?.webhookUrl) return;

    const row = this.deliveryRepository.create({
      partnerId: partner.id,
      cardId,
      eventType,
      payload,
      status: WebhookDeliveryStatus.PENDING,
      attemptCount: 0,
      nextAttemptAt: new Date(),
    });
    await this.deliveryRepository.save(row);
  }
  /** Picks up due deliveries and attempts them. Called by the cron sweep. */
  async processDueDeliveries(): Promise<void> {
    const due = await this.deliveryRepository.find({
      where: {
        status: WebhookDeliveryStatus.PENDING,
        nextAttemptAt: LessThanOrEqual(new Date()),
      },
      take: 50,
    });

    for (const delivery of due) {
      await this.attemptDelivery(delivery);
    }
  }

  private async attemptDelivery(
    delivery: WebhookDeliveryEntity,
  ): Promise<void> {
    const partner = await this.partnerRepository.findOne({
      where: { id: delivery.partnerId },
    });
    if (!partner?.webhookUrl || !partner.webhookSecretEncrypted) {
      delivery.status = WebhookDeliveryStatus.DEAD_LETTER;
      delivery.lastError = 'Partner webhook is no longer configured';
      delivery.nextAttemptAt = null;
      await this.deliveryRepository.save(delivery);
      return;
    }

    const secret = this.encryptionService.decrypt(
      partner.webhookSecretEncrypted,
    );
    const body = JSON.stringify(delivery.payload);
    const timestamp = Date.now().toString();
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    try {
      const response = await fetch(partner.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
          'X-Webhook-Timestamp': timestamp,
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });

      delivery.lastResponseStatus = response.status;

      if (response.ok) {
        delivery.status = WebhookDeliveryStatus.DELIVERED;
        delivery.deliveredAt = new Date();
        delivery.nextAttemptAt = null;
        await this.deliveryRepository.save(delivery);
        return;
      }

      await this.recordFailureAndScheduleRetry(
        delivery,
        `HTTP ${response.status}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordFailureAndScheduleRetry(delivery, message);
    }
  }

  private async recordFailureAndScheduleRetry(
    delivery: WebhookDeliveryEntity,
    errorMessage: string,
  ): Promise<void> {
    delivery.attemptCount += 1;
    delivery.lastError = errorMessage;

    if (delivery.attemptCount >= MAX_ATTEMPTS) {
      delivery.status = WebhookDeliveryStatus.DEAD_LETTER;
      delivery.nextAttemptAt = null;
      this.logger.warn(
        `Webhook delivery ${delivery.publicId} dead-lettered after ${delivery.attemptCount} attempts: ${errorMessage}`,
      );
    } else {
      const attemptIndex = delivery.attemptCount - 1;
      const waitMinutes = BACKOFF_MINUTES[attemptIndex] ?? 120;
      delivery.nextAttemptAt = new Date(Date.now() + waitMinutes * 60_000);
    }

    await this.deliveryRepository.save(delivery);
  }
}
