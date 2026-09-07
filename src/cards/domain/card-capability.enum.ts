export enum CardCapability {
  ONBOARD_CARDHOLDER = 'ONBOARD_CARDHOLDER',
  /**
   * The issuer holds a person and reports that person's status. Not implied by
   * onboarding — an issuer can accept a cardholder and model none — and the
   * sync writes whatever this answers over the stored status.
   */
  CARDHOLDER_STATUS = 'CARDHOLDER_STATUS',
  ISSUE_VIRTUAL = 'ISSUE_VIRTUAL',
  ISSUE_PHYSICAL = 'ISSUE_PHYSICAL',
  ACTIVATE = 'ACTIVATE',
  BLOCK = 'BLOCK',
  SENSITIVE_REVEAL = 'SENSITIVE_REVEAL',
  DEPOSIT_ADDRESS = 'DEPOSIT_ADDRESS',
  BALANCE_READ = 'BALANCE_READ',
  /**
   * The issuer publishes the balance of **our own account with it**, never a
   * card's. **Not implied by `BALANCE_READ`** — an issuer funded by deposit
   * addresses holds no such account.
   */
  MERCHANT_BALANCE_READ = 'MERCHANT_BALANCE_READ',
  PIN_MANAGEMENT = 'PIN_MANAGEMENT',
  TRANSACTIONS_READ = 'TRANSACTIONS_READ',
  PRODUCT_CATALOGUE = 'PRODUCT_CATALOGUE',
  /**
   * The issuer opens a card asynchronously; the outcome is fetched separately.
   * Its own flag, so a synchronous issuer is never asked on every sweep for a
   * result that does not exist.
   */
  APPLICATION_RESULT = 'APPLICATION_RESULT',
  /**
   * The issuer acknowledges a lifecycle operation and carries it out later, so
   * the outcome is fetched separately. **Not implied by `BLOCK`**: an issuer
   * that applies the change during the call has no second outcome, and a shared
   * flag would have a reconcile select rows nothing can answer for.
   */
  OPERATION_RESULT = 'OPERATION_RESULT',
  /**
   * The issuer lets the caller choose the name printed on the card. Declaring
   * it makes `nameOnCard` required; not declaring it makes supplying one an
   * error rather than a value that silently vanishes.
   */
  CUSTOM_NAME_ON_CARD = 'CUSTOM_NAME_ON_CARD',
  /**
   * The issuer accepts money onto an existing card, funded from our account
   * with them rather than an address the cardholder pays into. One flag covers
   * both requesting a deposit and asking what became of it.
   */
  DEPOSIT = 'DEPOSIT',
  /**
   * The issuer prices a deposit before one is made. **Not implied by
   * `DEPOSIT`** — one can take a deposit and publish no rate to quote from.
   */
  FUNDING_QUOTE = 'FUNDING_QUOTE',
  /**
   * The issuer posts asynchronous results to an address we registered with it.
   * Covers reading one delivery and answering it — both or neither.
   */
  CALLBACK_EVENTS = 'CALLBACK_EVENTS',
}
