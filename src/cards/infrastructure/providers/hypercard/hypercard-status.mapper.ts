import { Logger } from '@nestjs/common';
import { CardActivationStatus } from '../../../domain/card-activation-status.enum';
import { CardStatus } from '../../../domain/card-status.enum';
import { normaliseHyperCardInteger } from './hypercard-coercion.util';
import { HyperCardCardApplicationStatus as Code } from './hypercard.types';

const logger = new Logger('HyperCardStatusMapper');

/**
 * Their status codes arrive typed inconsistently — integers on query
 * endpoints, strings in push events, and one push declares `status` a number
 * while rendering it `"2"` in its own sample.
 */

/**
 * What one of their codes says. `activation` is present only on the four codes
 * that describe an activation attempt itself; on every other code the card's
 * activation stage is simply not what the value is about, which is why it is
 * absent rather than a third member meaning "none".
 */
interface Reading {
  card: CardStatus;
  activation?: CardActivationStatus;
}

/**
 * Their "Card Application Status" appendix. It describes a card and only a
 * card: this issuer holds no person for a status to be about.
 *
 * **One row per provider code, carrying every reading taken from it.** Parallel
 * tables would let a code be added to one and not the other, and since the
 * unknown branch warns rather than throws that divergence would surface as a
 * stray log line rather than a failure.
 */
const READING_BY_CODE: Record<number, Reading> = {
  [Code.OPENING_PRE_APPLY]: { card: CardStatus.NOT_ACTIVATED },
  [Code.OPENING_PENDING_PAYMENT]: { card: CardStatus.NOT_ACTIVATED },
  [Code.OPENING_REVIEWING]: { card: CardStatus.NOT_ACTIVATED },
  [Code.OPENING_REVIEWED_SUCCESS]: { card: CardStatus.NOT_ACTIVATED },
  [Code.OPENING_REVIEWED_REJECTED]: { card: CardStatus.CLOSED },
  [Code.OPENING_REFUNDED]: { card: CardStatus.CLOSED },
  [Code.OPENING_SHIPPED]: { card: CardStatus.NOT_ACTIVATED },
  [Code.OPENING_ACTIVATING]: {
    card: CardStatus.NOT_ACTIVATED,
    activation: CardActivationStatus.PENDING,
  },
  // Not `CLOSED`: their `E`-prefixed fail codes are activation-photo defects,
  // so the card was opened and is eligible for another attempt.
  [Code.OPENING_ACTIVATION_FAILED]: {
    card: CardStatus.NOT_ACTIVATED,
    activation: CardActivationStatus.FAILED,
  },
  [Code.OPENING_ACTIVATED]: { card: CardStatus.ACTIVE },
  [Code.ACTIVE_FREEZE]: { card: CardStatus.ON_HOLD },
  [Code.ACTIVATION_REVIEWING]: {
    card: CardStatus.NOT_ACTIVATED,
    activation: CardActivationStatus.PENDING,
  },
  [Code.ACTIVATION_REVIEWED_REJECTED]: {
    card: CardStatus.NOT_ACTIVATED,
    activation: CardActivationStatus.FAILED,
  },
  [Code.ACTIVATION_REVIEWED_SUCCESS]: { card: CardStatus.ACTIVE },
  [Code.CANCELLING]: { card: CardStatus.CLOSED },
  [Code.CANCELLED]: { card: CardStatus.CLOSED },
  [Code.PASSIVE_FREEZE]: { card: CardStatus.ON_HOLD },
  [Code.REFUND_REVIEWING]: { card: CardStatus.CLOSED },
  [Code.REFUND_REVIEWED_REJECTED]: { card: CardStatus.CLOSED },
  [Code.REFUND_REVIEWED_SUCCESS]: { card: CardStatus.CLOSED },
  [Code.OPENING_WAIT_ATTACHMENT]: { card: CardStatus.NOT_ACTIVATED },
  [Code.WAIT_FOR_RECHARGE]: { card: CardStatus.NOT_ACTIVATED },
};

const readingOf = (raw: number | string): Reading | undefined => {
  const code = normaliseHyperCardInteger(raw);
  return code === null ? undefined : READING_BY_CODE[code];
};

/**
 * Their code as a card status, or null when their appendix does not carry it.
 *
 * **The strict read**, for a caller that must not act on a code it cannot
 * read. `mapHyperCardCardStatus` below degrades instead, which is right for an
 * answer about a card we asked about and wrong for one that moves a live card.
 */
export const readHyperCardCardStatus = (
  raw: number | string,
): CardStatus | null => readingOf(raw)?.card ?? null;

export const mapHyperCardCardStatus = (raw: number | string): CardStatus => {
  const reading = readingOf(raw);

  if (reading === undefined) {
    // Warned and degraded, never thrown, and deliberately not a silent
    // `?? DEFAULT`. `NOT_ACTIVATED` withholds a card rather than announcing
    // one this mapper cannot read.
    logger.warn(
      `Unrecognised HyperCard card application status "${String(raw)}" — treating it as ${CardStatus.NOT_ACTIVATED}. ` +
        `Check their "Card Application Status" appendix for a value added since this mapper was written.`,
    );
    return CardStatus.NOT_ACTIVATED;
  }

  return reading.card;
};

/**
 * Where their code says an activation attempt stands, or null when the code is
 * not about one.
 *
 * **Null is "no information", never "nothing is pending".** They report a card
 * at its pre-activation code for a while after accepting an activation, so a
 * caller that read null as "not pending" would clear a stored `PENDING` during
 * exactly the window it exists for. Unrecognised codes take the same arm
 * without a second warning — the card-status mapper above already raises one.
 */
export const mapHyperCardActivationStatus = (
  raw: number | string,
): CardActivationStatus | null => readingOf(raw)?.activation ?? null;
