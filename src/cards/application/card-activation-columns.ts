import { CardActivationStatus } from '../domain/card-activation-status.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardEntity } from '../infrastructure/persistence/card.entity';

/**
 * **One object so both fields come off one answer** — an adapter's outcome
 * satisfies it directly, and no caller can pair them from two sources.
 */
export interface CardActivationReading {
  /** What the issuer says the card's status is now. */
  status: CardStatus;
  /** Where the issuer says an activation stands; absent where it said nothing. */
  activation?: CardActivationStatus;
}

/** The three columns an activation reading writes, or null for none of them. */
export type CardActivationColumns = Pick<
  CardEntity,
  'activationStatus' | 'activationReasonCode' | 'activationReason'
>;

/**
 * What a reading should write about a card's activation, or null to leave
 * every activation column as it stands.
 *
 * **An issuer saying nothing about an activation is saying nothing, not saying
 * there is none** — only the card reaching active clears these columns.
 */
export const activationColumnsFor = (
  reading: CardActivationReading,
  /** The issuer's own code and words for a refused activation, cut to their columns. */
  reasonCode: string | null = null,
  reason: string | null = null,
): CardActivationColumns | null => {
  if (reading.status === CardStatus.ACTIVE) {
    return {
      activationStatus: null,
      activationReasonCode: null,
      activationReason: null,
    };
  }

  if (reading.activation === CardActivationStatus.FAILED) {
    return {
      activationStatus: CardActivationStatus.FAILED,
      activationReasonCode: reasonCode,
      activationReason: reason,
    };
  }

  if (reading.activation === CardActivationStatus.PENDING) {
    return {
      activationStatus: CardActivationStatus.PENDING,
      activationReasonCode: null,
      activationReason: null,
    };
  }

  return null;
};
