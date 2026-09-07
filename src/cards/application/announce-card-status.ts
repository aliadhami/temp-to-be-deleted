import { Logger } from '@nestjs/common';
import { WebhookDeliveryService } from '../../payments/infrastructure/webhooks/webhook-delivery.service';
import { CardStatus } from '../domain/card-status.enum';
import { CardEntity } from '../infrastructure/persistence/card.entity';

type AnnounceableCard = Pick<CardEntity, 'id' | 'publicId' | 'partnerId'>;

/**
 * Tells the partner a card moved. **On the transition, never on the state.**
 *
 * Guarded rather than propagated: every caller reaches this once the card row
 * has moved, so a retry would find no transition left to announce.
 */
export const announceCardStatus = async (
  webhookDeliveryService: WebhookDeliveryService,
  logger: Logger,
  card: AnnounceableCard,
  status: CardStatus,
): Promise<void> => {
  try {
    await webhookDeliveryService.enqueueForCard(
      card.id,
      card.partnerId,
      'card.status_updated',
      {
        eventType: 'card.status_updated',
        cardPublicId: card.publicId,
        status,
        occurredAt: new Date().toISOString(),
      },
    );
  } catch (error) {
    logger.error(
      `Card ${card.publicId} reached ${status} and the partner could not be notified: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};
