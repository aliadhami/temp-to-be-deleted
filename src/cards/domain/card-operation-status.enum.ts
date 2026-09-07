/**
 * The lifecycle of one lifecycle operation requested against a card that
 * already exists — not the card's status, and not an application's. A
 * `varchar` on the row rather than a database enum, so a new state costs no
 * migration.
 */
export enum CardOperationStatus {
  /** Written before the outbound call, so a crash mid-flight leaves a record. */
  DRAFT = 'DRAFT',

  /**
   * Acknowledged; whether the issuer carried it out must be looked up. The
   * healthy pending state, not a fault.
   */
  SUBMITTED = 'SUBMITTED',

  /** The call failed before acknowledgement. No outcome to look up. */
  SUBMISSION_FAILED = 'SUBMISSION_FAILED',

  /** Read and refused outright. The issuer never took the request on. */
  REJECTED = 'REJECTED',

  /** The issuer carried the operation out. Terminal. */
  APPLIED = 'APPLIED',

  /**
   * The issuer took the request on and did not carry it out. Terminal —
   * unlike a deposit's failure, which can still be refunded. There is nothing
   * to reverse and no state after it.
   */
  FAILED = 'FAILED',
}

/** The states an operation never leaves. */
export const TERMINAL_CARD_OPERATION_STATUSES: readonly CardOperationStatus[] =
  [
    CardOperationStatus.APPLIED,
    CardOperationStatus.FAILED,
    CardOperationStatus.REJECTED,
  ];

/**
 * The states in which the issuer was never left holding a request of ours. Not
 * terminal, but there is nothing at the issuer to ask about either.
 */
export const UNSENT_CARD_OPERATION_STATUSES: readonly CardOperationStatus[] = [
  CardOperationStatus.DRAFT,
  CardOperationStatus.SUBMISSION_FAILED,
];

/**
 * The states a result lookup still has a question about — derived, so a member
 * added later is polled by default rather than silently ignored. The two sets
 * above are the ones a new member must be added to deliberately.
 */
export const OUTSTANDING_CARD_OPERATION_STATUSES: readonly CardOperationStatus[] =
  Object.values(CardOperationStatus).filter(
    (status) =>
      !TERMINAL_CARD_OPERATION_STATUSES.includes(status) &&
      !UNSENT_CARD_OPERATION_STATUSES.includes(status),
  );

/**
 * The states in which a card cannot take another operation — the issuer
 * accepts one at a time. `DRAFT` holds the card without being polled, since a
 * row written before the call may be mid-flight; `SUBMISSION_FAILED` is the
 * one non-terminal state that frees it, since the request is known not to have
 * landed.
 *
 * This is the expression behind `card_operation.in_flight_card_id`, so
 * changing it changes the generated column and `schema:log` asks for a
 * migration. **Reordering the members above does that too** — the expression
 * is built in declaration order, so a cosmetic tidy is a schema change.
 */
export const IN_FLIGHT_CARD_OPERATION_STATUSES: readonly CardOperationStatus[] =
  Object.values(CardOperationStatus).filter(
    (status) =>
      !TERMINAL_CARD_OPERATION_STATUSES.includes(status) &&
      status !== CardOperationStatus.SUBMISSION_FAILED,
  );
