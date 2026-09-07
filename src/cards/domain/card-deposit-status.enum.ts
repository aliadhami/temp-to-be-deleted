/**
 * The lifecycle of one attempt to put money on an already-issued card — not
 * the card's status, and not an application's. A `varchar` on the row rather
 * than a database enum, so a new state costs no migration.
 */
export enum CardDepositStatus {
  /** Written before the outbound call, so a crash mid-flight leaves a record. */
  DRAFT = 'DRAFT',

  /**
   * Acknowledged; whether it settled must be looked up. The healthy pending
   * state, not a fault.
   */
  SUBMITTED = 'SUBMITTED',

  /** The call failed before acknowledgement. No outcome to look up, no money moved. */
  SUBMISSION_FAILED = 'SUBMISSION_FAILED',

  /** Read and refused outright. Nothing to settle, refund or look up. */
  REJECTED = 'REJECTED',

  /** The issuer credited the card. Terminal. */
  SETTLED = 'SETTLED',

  /**
   * Refused after acceptance; `reason_code` and `message` carry why. Not
   * terminal — a failed deposit can still be refunded, so a pass that stops
   * watching here reports money lost that was in fact returned.
   */
  FAILED = 'FAILED',

  /** The issuer has undertaken to return the money. Also not terminal. */
  REFUND_PENDING = 'REFUND_PENDING',

  /** The money went back. Terminal. */
  REFUNDED = 'REFUNDED',
}

/** The states a deposit never leaves. */
export const TERMINAL_CARD_DEPOSIT_STATUSES: readonly CardDepositStatus[] = [
  CardDepositStatus.SETTLED,
  CardDepositStatus.REFUNDED,
  CardDepositStatus.REJECTED,
];

/**
 * The states in which the issuer was never left holding a request of ours. Not
 * terminal, but there is nothing at the issuer to ask about either.
 */
export const UNSENT_CARD_DEPOSIT_STATUSES: readonly CardDepositStatus[] = [
  CardDepositStatus.DRAFT,
  CardDepositStatus.SUBMISSION_FAILED,
];

/**
 * The states a settlement lookup still has a question about — derived, so a
 * member added later is polled by default rather than silently ignored. The
 * two sets above are the ones a new member must be added to deliberately.
 */
export const OUTSTANDING_CARD_DEPOSIT_STATUSES: readonly CardDepositStatus[] =
  Object.values(CardDepositStatus).filter(
    (status) =>
      !TERMINAL_CARD_DEPOSIT_STATUSES.includes(status) &&
      !UNSENT_CARD_DEPOSIT_STATUSES.includes(status),
  );
