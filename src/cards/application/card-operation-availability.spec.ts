import { CardCapability } from '../domain/card-capability.enum';
import { CardLifecycleOperation } from '../domain/card-lifecycle-operation.enum';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardOperationAvailability } from './card-operation-availability';
import { CardProductResolver } from './card-product-resolver';

/** Products this issuer's catalogue holds, keyed by internal id. */
const resolverFor = (
  products: Record<string, CardLifecycleOperation[]> = {},
): CardProductResolver =>
  ({
    supportedOperationsByProductId: (ids: readonly string[]) =>
      Promise.resolve(
        new Map(
          ids
            .filter((id) => id in products)
            .map((id) => [id, products[id] as CardLifecycleOperation[]]),
        ),
      ),
  }) as unknown as CardProductResolver;

const availabilityFor = (
  capabilities: CardCapability[],
  products: Record<string, CardLifecycleOperation[]> = {},
): CardOperationAvailability =>
  new CardOperationAvailability(
    {
      capabilitiesOf: () => new Set(capabilities),
    } as unknown as CardIssuerRegistry,
    resolverFor(products),
  );

/** What an issuer that blocks and manages PINs declares. */
const BLOCKS_AND_PINS = [CardCapability.BLOCK, CardCapability.PIN_MANAGEMENT];

describe('CardOperationAvailability', () => {
  describe('a card whose issuer publishes no catalogue', () => {
    it('answers from the capabilities alone', () => {
      expect(
        availabilityFor(BLOCKS_AND_PINS).forCard(CardProviderKey.AXYS, null),
      ).toEqual([
        CardLifecycleOperation.BLOCK,
        CardLifecycleOperation.UNBLOCK,
        CardLifecycleOperation.CHANGE_PIN,
      ]);
    });

    it('yields both directions of a freeze from the one capability', () => {
      expect(
        availabilityFor([CardCapability.BLOCK]).forCard(
          CardProviderKey.AXYS,
          null,
        ),
      ).toEqual([CardLifecycleOperation.BLOCK, CardLifecycleOperation.UNBLOCK]);
    });
  });

  describe('a card whose product names what it offers', () => {
    it('narrows the capabilities to the product’s list', () => {
      expect(
        availabilityFor(BLOCKS_AND_PINS).forCard(CardProviderKey.AXYS, [
          CardLifecycleOperation.BLOCK,
        ]),
      ).toEqual([CardLifecycleOperation.BLOCK]);
    });

    it('answers empty for a product that offers none of them', () => {
      expect(
        availabilityFor(BLOCKS_AND_PINS).forCard(CardProviderKey.HYPERCARD, []),
      ).toEqual([]);
    });

    it('applies both bounds, not whichever is narrower', () => {
      // A member survives only when the issuer can carry it out *and* the
      // product offers it.
      expect(
        availabilityFor([CardCapability.BLOCK]).forCard(
          CardProviderKey.HYPERCARD,
          [CardLifecycleOperation.BLOCK, CardLifecycleOperation.CHANGE_PIN],
        ),
      ).toEqual([CardLifecycleOperation.BLOCK]);
    });

    it('drops an operation no route exists for, whatever the product says', () => {
      expect(
        availabilityFor(BLOCKS_AND_PINS).forCard(CardProviderKey.HYPERCARD, [
          CardLifecycleOperation.REPORT_LOSS,
          CardLifecycleOperation.RESET_PASSWORD,
          CardLifecycleOperation.REISSUE,
          CardLifecycleOperation.CANCEL,
        ]),
      ).toEqual([]);
    });

    it('publishes a stable order whatever order the issuer listed its own in', () => {
      expect(
        availabilityFor(BLOCKS_AND_PINS).forCard(CardProviderKey.HYPERCARD, [
          CardLifecycleOperation.CHANGE_PIN,
          CardLifecycleOperation.UNBLOCK,
          CardLifecycleOperation.BLOCK,
        ]),
      ).toEqual([
        CardLifecycleOperation.BLOCK,
        CardLifecycleOperation.UNBLOCK,
        CardLifecycleOperation.CHANGE_PIN,
      ]);
    });
  });

  it('answers empty for a provider a deployment has switched off', () => {
    expect(
      availabilityFor([]).forCard(CardProviderKey.AXYS, [
        CardLifecycleOperation.BLOCK,
      ]),
    ).toEqual([]);
  });

  describe('resolving a batch of cards against the catalogue', () => {
    it('narrows each card to its own product', async () => {
      const availability = availabilityFor(BLOCKS_AND_PINS, {
        '10': [CardLifecycleOperation.BLOCK, CardLifecycleOperation.UNBLOCK],
        '20': [CardLifecycleOperation.CHANGE_PIN],
      });

      await expect(
        availability.forCards([
          { providerKey: CardProviderKey.HYPERCARD, cardProductId: '10' },
          { providerKey: CardProviderKey.HYPERCARD, cardProductId: '20' },
        ]),
      ).resolves.toEqual([
        [CardLifecycleOperation.BLOCK, CardLifecycleOperation.UNBLOCK],
        [CardLifecycleOperation.CHANGE_PIN],
      ]);
    });

    it('answers from the capabilities alone for a card naming no product', async () => {
      await expect(
        availabilityFor(BLOCKS_AND_PINS).forCards([
          { providerKey: CardProviderKey.AXYS, cardProductId: null },
        ]),
      ).resolves.toEqual([
        [
          CardLifecycleOperation.BLOCK,
          CardLifecycleOperation.UNBLOCK,
          CardLifecycleOperation.CHANGE_PIN,
        ],
      ]);
    });

    it('narrows a product it could not read to nothing, not to the capabilities', async () => {
      // The two inputs are not interchangeable. Answering an unreadable
      // product the way a card with no product is answered would publish the
      // issuer's whole list for a card whose product may offer none of it.
      await expect(
        availabilityFor(BLOCKS_AND_PINS).forCards([
          { providerKey: CardProviderKey.HYPERCARD, cardProductId: '404' },
        ]),
      ).resolves.toEqual([[]]);
    });

    it('reads the catalogue once for a page, never once per card', async () => {
      const resolver = resolverFor({
        '10': [CardLifecycleOperation.BLOCK],
      });
      const lookup = jest.spyOn(resolver, 'supportedOperationsByProductId');
      const availability = new CardOperationAvailability(
        {
          capabilitiesOf: () => new Set(BLOCKS_AND_PINS),
        } as unknown as CardIssuerRegistry,
        resolver,
      );

      await availability.forCards([
        { providerKey: CardProviderKey.HYPERCARD, cardProductId: '10' },
        { providerKey: CardProviderKey.HYPERCARD, cardProductId: '10' },
        { providerKey: CardProviderKey.AXYS, cardProductId: null },
      ]);

      expect(lookup).toHaveBeenCalledTimes(1);
      // Deduplicated, so a page of cards on one product asks about it once.
      expect(lookup).toHaveBeenCalledWith(['10']);
    });
  });
});
