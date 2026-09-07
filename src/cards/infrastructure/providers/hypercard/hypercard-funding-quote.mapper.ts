import { CardFundingQuoteResult } from '../../../domain/card-issuer.port';
import {
  normaliseHyperCardText,
  readHyperCardAmount,
} from './hypercard-coercion.util';
import { HyperCardCryptoEstimateData } from './hypercard.types';

/** Their "Estimate crypto" answer could not be turned into a quote. */
export class HyperCardFundingQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HyperCardFundingQuoteError';
  }
}

/** What the caller sent, so the answer can be checked against the question. */
export interface HyperCardFundingQuoteContext {
  payCoin: string;
  /** Used when they echo none. */
  cardCurrencyCode: string;
  quotedAt: Date;
}

const readAmount = (raw: unknown, field: string): string =>
  readHyperCardAmount(
    raw,
    (value) =>
      new HyperCardFundingQuoteError(
        `HyperCard returned ${field} "${String(
          value,
        )}" on a crypto estimate, which is not an amount this can read`,
      ),
  );

/**
 * Their crypto estimate, as the port's quote. **`recharge_amount` is fiat on
 * the way in and pay-coin on the way back**, so the cost is that field and the
 * fiat that lands is `currency_amount` — swapping them changes both the unit
 * and the currency of a money value, invisibly.
 */
export const mapHyperCardFundingQuote = (
  data: unknown,
  context: HyperCardFundingQuoteContext,
): CardFundingQuoteResult => {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new HyperCardFundingQuoteError(
      `HyperCard answered a crypto estimate with a ${
        Array.isArray(data) ? 'list' : typeof data
      } where their page documents an object`,
    );
  }

  const row = data as HyperCardCryptoEstimateData;

  const quotedCoin = normaliseHyperCardText(row.pay_coin);
  // Before anything is read for meaning: a cost denominated in a coin other
  // than the one asked for misstates money.
  if (
    quotedCoin !== null &&
    quotedCoin.toUpperCase() !== context.payCoin.toUpperCase()
  ) {
    throw new HyperCardFundingQuoteError(
      `HyperCard priced a deposit in ${quotedCoin} for a request that named ${context.payCoin} — the cost cannot be trusted to be denominated in the coin it will be paid in`,
    );
  }

  const coin = (quotedCoin ?? context.payCoin).toUpperCase();
  const creditedCurrency =
    normaliseHyperCardText(row.card_coin)?.toUpperCase() ??
    context.cardCurrencyCode.toUpperCase();

  return {
    credited: {
      amount: readAmount(row.currency_amount, 'currency_amount'),
      currencyCode: creditedCurrency,
    },
    cost: {
      amount: readAmount(row.recharge_amount, 'recharge_amount'),
      currencyCode: coin,
    },
    fee: {
      amount: readAmount(row.recharge_fee_amount, 'recharge_fee_amount'),
      currencyCode: coin,
    },
    quotedAt: context.quotedAt.toISOString(),
  };
};
