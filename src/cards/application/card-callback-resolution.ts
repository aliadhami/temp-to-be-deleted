import { CardCapability } from '../domain/card-capability.enum';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';

/**
 * What a single-row resolution driven by a callback found. All three are
 * acknowledged to the issuer — a retry improves none of them — but only
 * `RESOLVED` means work happened.
 */
export type CardCallbackResolution =
  | 'RESOLVED'
  /** Nothing here holds that reference in a state still worth asking about. */
  | 'NO_ROW'
  /** The row is here and names a card carrying no issuer id to ask by. */
  | 'UNRESOLVABLE';

/**
 * Whether this provider reports the outcome a callback is about. The batch
 * passes apply the same test as a filter on the query that loads their page.
 */
export const providerReportsOutcome = (
  registry: CardIssuerRegistry,
  capability: CardCapability,
  providerKey: CardProviderKey,
): boolean => registry.keysWithCapability(capability).includes(providerKey);
