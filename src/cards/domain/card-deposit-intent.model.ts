/**
 * How long a partner's idempotency key for a deposit may be. Lives in
 * `domain/` so the DTO, the use case and the entity read one number.
 */
export const CARD_DEPOSIT_REQUEST_ID_MAX_LENGTH = 64;

/**
 * What an issuer needs to put money on an existing card. There is deliberately
 * no coin field.
 */
export interface CardDepositIntent {
  /**
   * Our own reference, and what a settlement lookup is keyed on. A canonical
   * UUID — an adapter may derive its wire form from this, and that derivation
   * is only collision-free for a canonical UUID.
   */
  reference: string;

  /**
   * The amount to land on the card. Decimal string, never a JS `number`, and
   * never minor units — the currencies in play do not share one exponent.
   */
  amount: string;

  /**
   * The card's own currency. Carried so an adapter can check what an issuer
   * says it credited against what the card is denominated in.
   */
  currencyCode: string;

  /** Free text passed through to an issuer that accepts it. */
  remark?: string;
}
