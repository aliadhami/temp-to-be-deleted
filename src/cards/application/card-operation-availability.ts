import { Injectable } from '@nestjs/common';
import { CardCapability } from '../domain/card-capability.enum';
import { CardLifecycleOperation } from '../domain/card-lifecycle-operation.enum';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardProductResolver } from './card-product-resolver';

/**
 * The operations each capability puts behind a route. **One capability yields
 * both directions of a freeze** — the port has a single method for them.
 *
 * A card's list is bounded by this map, so it can never name an operation with
 * no route. A product's `supportedOperations` is not, and deliberately.
 */
const OPERATIONS_BY_CAPABILITY: ReadonlyArray<
  readonly [CardCapability, readonly CardLifecycleOperation[]]
> = [
  [
    CardCapability.BLOCK,
    [CardLifecycleOperation.BLOCK, CardLifecycleOperation.UNBLOCK],
  ],
  [CardCapability.PIN_MANAGEMENT, [CardLifecycleOperation.CHANGE_PIN]],
];

/** One card's two inputs. */
export interface CardOperationAvailabilityEntry {
  providerKey: CardProviderKey;
  cardProductId: string | null;
}

/**
 * What one card accepts now — the answer a partner reads and the answer a
 * lifecycle request is validated against, so a control this API offers cannot
 * be a request it then refuses.
 */
@Injectable()
export class CardOperationAvailability {
  constructor(
    private readonly cardIssuerRegistry: CardIssuerRegistry,
    private readonly cardProductResolver: CardProductResolver,
  ) {}

  /**
   * What each of these cards accepts now, aligned to the entries given. **One
   * product query for the whole batch, never one per card** — and the one
   * place the product lookup is turned into the narrowing below, so a card
   * read and a lifecycle request cannot disagree about what a card accepts.
   */
  async forCards(
    entries: ReadonlyArray<CardOperationAvailabilityEntry>,
  ): Promise<CardLifecycleOperation[][]> {
    const productIds = new Set(
      entries
        .map((entry) => entry.cardProductId)
        .filter((productId) => productId !== null),
    );

    const operationsByProductId =
      await this.cardProductResolver.supportedOperationsByProductId([
        ...productIds,
      ]);

    return entries.map((entry) =>
      this.forCard(
        entry.providerKey,
        // A product we could not read narrows to nothing. `null` means "names
        // no product" and is not interchangeable here: answering it that way
        // would publish the issuer's whole list for a card whose product may
        // offer none of it.
        entry.cardProductId === null
          ? null
          : (operationsByProductId.get(entry.cardProductId) ?? []),
      ),
    );
  }

  /**
   * `productOperations` is `null` only for a card with no product, which
   * narrows against nothing. `[]` is a product offering none, which narrows to
   * nothing — never the same answer.
   */
  forCard(
    providerKey: CardProviderKey,
    productOperations: readonly CardLifecycleOperation[] | null,
  ): CardLifecycleOperation[] {
    const capabilities = this.cardIssuerRegistry.capabilitiesOf(providerKey);

    const available: CardLifecycleOperation[] = [];
    // Driven by the map, not by the product, so the order is ours rather than
    // whichever order an issuer published its codes in.
    for (const [capability, operations] of OPERATIONS_BY_CAPABILITY) {
      if (!capabilities.has(capability)) continue;
      for (const operation of operations) {
        if (
          productOperations !== null &&
          !productOperations.includes(operation)
        )
          continue;
        available.push(operation);
      }
    }

    return available;
  }
}
