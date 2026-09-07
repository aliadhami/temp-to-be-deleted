import { CardStatus } from './card-status.enum';

/**
 * An operation a partner can request against a card that already exists. The
 * meaning of an issuer's operation, never its encoding — an issuer's own
 * numbering stays inside its adapter folder.
 *
 * **A member is not a promise this API can carry it out.** Only `BLOCK`,
 * `UNBLOCK` and `CHANGE_PIN` have routes; the rest are published because an
 * issuer offers them. Anything drawing a control per member checks the route.
 */
export enum CardLifecycleOperation {
  /** Stop the card spending, reversibly. */
  BLOCK = 'BLOCK',

  /** Lift a block. An issuer may still refuse one it placed itself. */
  UNBLOCK = 'UNBLOCK',

  /** Set the card's PIN. One issuer changes it against the current PIN; another only resets it. */
  CHANGE_PIN = 'CHANGE_PIN',

  /** Declare the card lost. Terminal at the issuer. */
  REPORT_LOSS = 'REPORT_LOSS',

  /** Reset the credential an issuer keeps beside the PIN. Their own list keeps this and `CHANGE_PIN` apart without saying how they differ. */
  RESET_PASSWORD = 'RESET_PASSWORD',

  /** Replace the physical card, keeping the account behind it. */
  REISSUE = 'REISSUE',

  /** Close the card permanently. Returns any remaining balance. */
  CANCEL = 'CANCEL',
}

/**
 * Where each operation leaves the card once an issuer has carried it out.
 * **Not every operation moves a status** — a PIN change does not — so one absent
 * here leaves the card exactly as it stands.
 *
 * Here rather than beside either reader: the request path and the reconcile both
 * need it, and two copies would disagree silently — a request accepted and an
 * outcome recorded against a card that never moved.
 */
export const CARD_STATUS_BY_LIFECYCLE_OPERATION: Partial<
  Record<CardLifecycleOperation, CardStatus>
> = {
  [CardLifecycleOperation.BLOCK]: CardStatus.ON_HOLD,
  [CardLifecycleOperation.UNBLOCK]: CardStatus.ACTIVE,
};

/**
 * The statuses a card can be operated on from, and the only ones an outcome may
 * move it back into. **Listed, never derived from the targets above** — which
 * today are the same two: an operation that closed a card would put `CLOSED`
 * among them, and a closed card must never become operable again.
 */
export const OPERABLE_CARD_STATUSES: readonly CardStatus[] = [
  CardStatus.ACTIVE,
  CardStatus.ON_HOLD,
];
