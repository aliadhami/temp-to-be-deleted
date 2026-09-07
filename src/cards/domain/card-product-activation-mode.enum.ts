/**
 * How a card issued against a product leaves its not-activated state — the
 * *meaning* of an issuer's activation setting, not its encoding.
 */
export enum CardProductActivationMode {
  /**
   * The issuer contacts the cardholder and activation completes without us.
   * There is nothing to call — the only way to learn it happened is to observe
   * the card.
   */
  CARDHOLDER_DIRECT = 'CARDHOLDER_DIRECT',

  /** We activate the card by calling the issuer. */
  ISSUER_REQUEST = 'ISSUER_REQUEST',
}
