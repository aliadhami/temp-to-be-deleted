/**
 * How a card issued against a product yields its number, security code and
 * expiry — the *meaning* of an issuer's setting, not its encoding.
 */
export enum CardProductSensitiveDetailMode {
  /** The card's details are returned through the reveal endpoint. */
  API = 'API',

  /**
   * The reveal endpoint returns a URL, and optionally a password, for a page
   * the cardholder opens. No card data crosses this system.
   */
  HOSTED_PAGE = 'HOSTED_PAGE',

  /**
   * The issuer sends the security code and expiry to the cardholder itself;
   * the reveal endpoint returns the card number only.
   */
  CARDHOLDER_DIRECT = 'CARDHOLDER_DIRECT',
}
