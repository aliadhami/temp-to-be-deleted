/** The merchant-defined transaction number this provider is addressed by. */

/**
 * The lower of the two caps they publish, and therefore the one every caller
 * is held to — minting to the smaller number keeps one derivation valid across
 * every endpoint.
 */
export const HYPERCARD_TRADE_NUMBER_MAX_LENGTH = 64;

/**
 * The canonical form `randomUUID()` writes into `public_id`, and the only
 * input this accepts. Requiring the shape rather than normalising whatever
 * arrives is what makes the derivation injective.
 */
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A transaction number could not be derived. Typed so a caller can tell it
 * apart from a call to HyperCard that failed.
 */
export class HyperCardTradeNumberError extends Error {
  constructor(reason: string) {
    super(`Cannot derive a HyperCard transaction number: ${reason}.`);
    this.name = 'HyperCardTradeNumberError';
  }
}

/**
 * Derives the transaction number from the public id of the row the request is
 * recorded on — the UUID with its dashes removed, lower-cased. Always 32 hex
 * characters, well inside their cap.
 */
export const buildHyperCardTradeNumber = (publicId: string): string => {
  // An invariant violation rather than input worth handling: the caller passes
  // a `randomUUID()` written by a table's own insert hook. This number is the
  // only thing that will correlate an outcome back to the row that asked for
  // it, so a wrong one loses the card or the money, not just the request.
  if (!CANONICAL_UUID.test(publicId)) {
    throw new HyperCardTradeNumberError(
      `public id "${publicId}" is not a canonical UUID`,
    );
  }

  return publicId.toLowerCase().replace(/-/g, '');
};

/** The wire form: 32 lower-case hex characters and nothing else. */
const WIRE_TRADE_NUMBER = /^[0-9a-f]{32}$/i;

/**
 * The reverse of the derivation above — the reference a callback carries back,
 * as the canonical UUID a stored row is addressed by.
 *
 * **Refuses anything else rather than guessing**: a reference that was never
 * ours is ordinary traffic, and reshaping one aims a lookup at another
 * environment's rows.
 */
export const parseHyperCardTradeNumber = (
  tradeNumber: string,
): string | null => {
  if (!WIRE_TRADE_NUMBER.test(tradeNumber)) return null;

  const hex = tradeNumber.toLowerCase();
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
};
