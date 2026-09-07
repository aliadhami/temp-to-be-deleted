import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryDeepPartialEntity, Repository } from 'typeorm';
import { WebhookDeliveryService } from '../../payments/infrastructure/webhooks/webhook-delivery.service';
import { stampCheckedAt } from '../../shared/persistence/rotation-stamp.util';
import { CardCapability } from '../domain/card-capability.enum';
import { CardEventSource } from '../domain/card-event-source.enum';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus, TERMINAL_CARD_STATUSES } from '../domain/card-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardApplicationEntity } from '../infrastructure/persistence/card-application.entity';
import { CardEventEntity } from '../infrastructure/persistence/card-event.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { announceCardStatus } from './announce-card-status';
import { activationColumnsFor } from './card-activation-columns';
import {
  CardCallbackResolution,
  providerReportsOutcome,
} from './card-callback-resolution';

/** Every column this reads from `card`, named so the query stays narrow. */
const CARD_COLUMNS = {
  id: true,
  publicId: true,
  partnerId: true,
  status: true,
} as const;

/** Recorded on the transition, so the less authoritative writer names itself. */
const FROM_NOTIFICATION =
  "status taken from the provider's own notification; their card lookup gave no usable answer";

/** What this handler decided the card's status is, and where it came from. */
interface StatusReading {
  status: CardStatus;
  /** Null when the issuer was asked and answered; the note to record otherwise. */
  fallback: string | null;
}

/**
 * Moves a card because its issuer announced that it moved.
 *
 * **No sweep stands behind this arm** — nothing re-reads a card once it is
 * `ACTIVE` — so it never throws and never declines to write: a delivery it
 * cannot act on leaves the card wrong until something else changes it.
 */
@Injectable()
export class ApplyIssuerCardStatusUseCase {
  private readonly logger = new Logger(ApplyIssuerCardStatusUseCase.name);

  constructor(
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    @InjectRepository(CardApplicationEntity)
    private readonly applicationRepository: Repository<CardApplicationEntity>,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
    private readonly webhookDeliveryService: WebhookDeliveryService,
    private readonly dataSource: DataSource,
  ) {}

  async execute(
    providerKey: CardProviderKey,
    providerCardId: string,
    announced: CardStatus,
  ): Promise<CardCallbackResolution> {
    const card = await this.cardRepository.findOne({
      // Both halves: a provider card id is one issuer's namespace and nothing
      // makes it unique across two.
      where: { providerKey, providerCardId },
      select: CARD_COLUMNS,
    });

    if (card === null) return 'NO_ROW';

    const reading = await this.read(
      providerKey,
      providerCardId,
      card,
      announced,
    );

    if (card.status === reading.status) return 'RESOLVED';

    if (TERMINAL_CARD_STATUSES.includes(card.status)) {
      this.logger.warn(
        `Card provider "${providerKey}" reports card ${card.publicId} is ${reading.status}, and it is ${card.status} here — leaving it, because nothing takes a card back out of that`,
      );
      return 'RESOLVED';
    }

    const previousStatus = card.status;
    const activation = activationColumnsFor({ status: reading.status });

    const moved = await this.dataSource.transaction(async (manager) => {
      const written = await manager
        .getRepository(CardEntity)
        .update({ id: card.id, status: previousStatus }, {
          status: reading.status,
          ...activation,
        } as QueryDeepPartialEntity<CardEntity>);

      if (written.affected === 0) return false;

      const events = manager.getRepository(CardEventEntity);
      await events.save(
        events.create({
          cardId: card.id,
          fromStatus: previousStatus,
          toStatus: reading.status,
          // `RECONCILE` would claim a timer noticed, and none can.
          source: CardEventSource.CALLBACK,
          detail: reading.fallback,
        }),
      );

      return true;
    });

    if (!moved) {
      this.logger.warn(
        `Card ${card.publicId} moved out of ${previousStatus} while its provider's status change was being applied — leaving whatever changed it to report the change`,
      );
      return 'RESOLVED';
    }

    await announceCardStatus(
      this.webhookDeliveryService,
      this.logger,
      card,
      reading.status,
    );
    return 'RESOLVED';
  }

  /**
   * Asks the issuer what the card is now, falling back to the notification.
   *
   * **Only an issued answer naming this exact card, at a status the adapter
   * could read, is taken.** The notification is the safer source otherwise:
   * the receiver already refused any code it could not read.
   */
  private async read(
    providerKey: CardProviderKey,
    providerCardId: string,
    card: CardEntity,
    announced: CardStatus,
  ): Promise<StatusReading> {
    const fromNotification: StatusReading = {
      status: announced,
      fallback: FROM_NOTIFICATION,
    };

    if (
      !providerReportsOutcome(
        this.cardIssuerRegistry,
        CardCapability.APPLICATION_RESULT,
        providerKey,
      )
    ) {
      // Unwarned: this issuer takes it on every delivery. The event records it.
      return fromNotification;
    }

    const application = await this.applicationRepository.findOne({
      where: { cardId: card.id },
      select: { id: true, requestId: true },
    });

    if (application === null) {
      this.logger.warn(
        `Card ${card.publicId} (${providerKey}) has no application row — taking its status from the provider's notification, which is all there is`,
      );
      return fromNotification;
    }

    // Before the call and whatever it answers: this asks the rotation's own
    // question, so the row has to rotate with it.
    await stampCheckedAt(this.cardRepository, 'card', [card.id]);

    try {
      const outcome = await this.cardIssuerRegistry
        .resolve(providerKey)
        // Read from the row, never rebuilt from the card: an adapter's wire
        // form is derived from this exact value.
        .getCardApplicationResult(application.requestId, {});

      if (outcome.state !== 'ISSUED') {
        this.logger.warn(
          `Card provider "${providerKey}" reports no card for application ${application.requestId}, which produced card ${card.publicId} — taking the status from their notification instead`,
        );
        return fromNotification;
      }

      if (outcome.providerCardId !== providerCardId) {
        this.logger.warn(
          `Card provider "${providerKey}" reports card "${outcome.providerCardId}" for application ${application.requestId}, but their notification named "${providerCardId}" — taking the status from the notification, which names the card this changed`,
        );
        return fromNotification;
      }

      if (!outcome.statusRecognised) {
        // Their default means not-activated: harmless to a pass watching a
        // card reach usable, backwards for a live one.
        this.logger.warn(
          `Card provider "${providerKey}" answered a status this integration cannot read for card ${card.publicId} — taking the status from their notification, which the receiver did read`,
        );
        return fromNotification;
      }

      return { status: outcome.status, fallback: null };
    } catch (error) {
      this.logger.warn(
        `Could not read card ${card.publicId} (${providerKey}) from its provider — taking the status from their notification: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return fromNotification;
    }
  }
}
