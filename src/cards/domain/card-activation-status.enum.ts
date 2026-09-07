/**
 * Whether an activation attempt is outstanding on a card, for an issuer that
 * accepts an activation and settles it afterwards.
 *
 * It is deliberately **not** a fifth `CardStatus`. A card mid-activation is
 * still not activated, and widening that enum would change what
 * `NOT_ACTIVATED` returns to every partner already filtering on it.
 *
 * Absent — a null column, an absent field — means no attempt is outstanding:
 * either none was ever made, or the card is already active.
 */
export enum CardActivationStatus {
  /** Accepted by the issuer and not yet settled. A further attempt is refused. */
  PENDING = 'PENDING',
  /** The issuer refused it. The card is still open and a corrected attempt is allowed. */
  FAILED = 'FAILED',
}
