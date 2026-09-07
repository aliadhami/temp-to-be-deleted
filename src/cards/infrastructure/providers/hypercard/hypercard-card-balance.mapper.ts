import { CardBalanceResult } from '../../../domain/card-issuer.port';
import {
  normaliseHyperCardText,
  readHyperCardAmount,
} from './hypercard-coercion.util';
import { HyperCardCardBalanceData } from './hypercard.types';

/**
 * Their "Balance Inquiry" answer could not be turned into a balance. Adapter-
 * local rather than a domain error — an unreadable payload is a gap of ours.
 */
export class HyperCardCardBalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HyperCardCardBalanceError';
  }
}

/**
 * An ISO-4217 alphabetic code, which is what `card.balance_currency` is three
 * characters wide to hold.
 */
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/;

/**
 * One of their two balance figures. A negative value is refused rather than
 * stored — they publish no negative amount anywhere, so one arriving means
 * either a payload we do not understand or a card in a state nothing here has
 * seen.
 */
const readAmount = (raw: unknown, field: string): string =>
  readHyperCardAmount(
    raw,
    (value) =>
      new HyperCardCardBalanceError(
        `HyperCard returned ${field} "${String(
          value,
        )}" on a balance inquiry, which is not an amount this can read`,
      ),
  );

/**
 * Their balance payload, as the port's balance result. `available_balance` is
 * what can be spent and `current_balance` is the ledger figure — their own
 * labelling, and the way round their example implies.
 */
export const mapHyperCardCardBalance = (
  data: HyperCardCardBalanceData,
  observedAt: Date,
): CardBalanceResult => {
  const available = readAmount(data.available_balance, 'available_balance');
  const ledger = readAmount(data.current_balance, 'current_balance');

  const currencyCode = normaliseHyperCardText(data.card_currency);
  if (currencyCode === null || !CURRENCY_PATTERN.test(currencyCode)) {
    throw new HyperCardCardBalanceError(
      `HyperCard returned card_currency "${String(
        data.card_currency,
      )}" on a balance inquiry, which is not a three-letter currency code`,
    );
  }

  return {
    available,
    ledger,
    // Uppercased here rather than stored as sent: they publish `"usd"` and
    // every other currency in this schema is upper case, so normalising the
    // case is the adapter's job.
    currencyCode: currencyCode.toUpperCase(),
    observedAt: observedAt.toISOString(),
  };
};
