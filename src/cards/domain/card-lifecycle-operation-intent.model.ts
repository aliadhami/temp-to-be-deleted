import { CardBlockReason } from './card-issuer.port';

/**
 * What an issuer needs to carry out a lifecycle operation against a card that
 * already exists.
 */
export interface CardLifecycleOperationIntent {
  /**
   * Our own reference, and what an issuer's operation-result lookup is keyed
   * on. A canonical UUID — an adapter may derive its wire form from this, and
   * that derivation is only collision-free for a canonical UUID.
   *
   * **Not `idempotencyKey`.** That is minted fresh per invocation, because a
   * card is blocked and unblocked repeatedly; this is the row's, and is stable
   * across a retry of the same operation.
   */
  reference: string;

  /** Where the card should end up. */
  status: 'active' | 'on_hold';

  /** Why, for an issuer that records one. Several accept no reason at all. */
  reason?: CardBlockReason;
}
