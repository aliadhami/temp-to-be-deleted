import { CardResponseDto } from '../api/dto/card-response.dto';
import { CardLifecycleOperation } from '../domain/card-lifecycle-operation.enum';
import { CardApplicationEntity } from '../infrastructure/persistence/card-application.entity';
import { CardOperationEntity } from '../infrastructure/persistence/card-operation.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';

/**
 * The one place a card row becomes a response, shared by the list and the
 * member read so a field cannot be added to one and forgotten on the other.
 * `application`, `availableOperations` and `lastOperation` are required and
 * nullable-or-empty rather than optional for that reason.
 */
export const toCardResponse = (
  card: CardEntity,
  cardholder: Pick<CardholderEntity, 'publicId'>,
  application: CardApplicationEntity | null,
  availableOperations: readonly CardLifecycleOperation[],
  lastOperation: CardOperationEntity | null,
): CardResponseDto => ({
  publicId: card.publicId,
  cardholderPublicId: cardholder.publicId,
  providerKey: card.providerKey,
  cardType: card.cardType,
  status: card.status,
  activationStatus: card.activationStatus,
  activationReasonCode: card.activationReasonCode,
  activationReason: card.activationReason,
  maskedPan: card.maskedPan,
  currency: card.currency,
  createdAt: card.createdAt,
  balance:
    card.balanceAvailable !== null
      ? {
          available: card.balanceAvailable,
          ledger: card.balanceLedger,
          currency: card.balanceCurrency,
          observedAt: card.balanceObservedAt,
        }
      : null,
  availableOperations,
  lastOperation: lastOperation
    ? {
        operation: lastOperation.operationType,
        status: lastOperation.status,
        reasonCode: lastOperation.reasonCode,
        reason: lastOperation.message,
        requestedAt: lastOperation.createdAt,
        lastCheckedAt: lastOperation.statusCheckedAt,
      }
    : null,
  issuance: application
    ? {
        status: application.status,
        reasonCode: application.reasonCode,
        reason: application.message,
        lastCheckedAt: application.statusCheckedAt,
      }
    : null,
});
