/**
 * What an issuer needs to price an opening deposit. **No coin field**, for the
 * reason `CardDepositIntent` has none: the funding coin is ours, not a
 * partner's.
 */
export interface CardFundingQuoteIntent {
  /** Decimal string, never a JS `number`, and never minor units. */
  depositAmount: string;
  /** The product's own currency, to check what the issuer quotes against. */
  currencyCode: string;
}
