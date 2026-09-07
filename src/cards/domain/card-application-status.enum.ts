/**
 * The lifecycle of one attempt to open a card account at an issuer — not
 * `CardStatus`.
 */
export enum CardApplicationStatus {
  /** Written before the outbound call, so a crash mid-flight leaves a record. */
  DRAFT = 'DRAFT',

  /**
   * Acknowledged; the outcome must be looked up. The healthy pending state,
   * not a fault.
   */
  SUBMITTED = 'SUBMITTED',

  /**
   * The call failed before acknowledgement. No outcome to look up, and the card
   * row this points at was never really opened.
   */
  SUBMISSION_FAILED = 'SUBMISSION_FAILED',

  /** The issuer accepted the application and a card exists. */
  APPROVED = 'APPROVED',

  /** Refused; `reason_code` and `message` carry why. */
  REJECTED = 'REJECTED',
}
