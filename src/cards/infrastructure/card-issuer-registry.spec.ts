import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CardCapability } from '../domain/card-capability.enum';
import { CardIssuerPort } from '../domain/card-issuer.port';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardIssuerRegistry } from './card-issuer-registry';

const adapter = (
  key: CardProviderKey,
  capabilities: CardCapability[],
): CardIssuerPort =>
  ({ key, capabilities: new Set(capabilities) }) as unknown as CardIssuerPort;

const registryWith = (enabled: CardProviderKey[]): CardIssuerRegistry => {
  const configService = {
    getOrThrow: jest.fn().mockReturnValue(enabled),
  } as unknown as ConfigService;

  const registry = new CardIssuerRegistry(configService, [
    adapter(CardProviderKey.AXYS, [
      CardCapability.BLOCK,
      CardCapability.PIN_MANAGEMENT,
    ]),
    adapter(CardProviderKey.HYPERCARD, [CardCapability.PRODUCT_CATALOGUE]),
  ]);
  registry.onModuleInit();
  return registry;
};

describe('CardIssuerRegistry', () => {
  describe('capabilitiesOf', () => {
    it('reports what an enabled provider declares', () => {
      const registry = registryWith([
        CardProviderKey.AXYS,
        CardProviderKey.HYPERCARD,
      ]);

      expect([...registry.capabilitiesOf(CardProviderKey.AXYS)]).toEqual([
        CardCapability.BLOCK,
        CardCapability.PIN_MANAGEMENT,
      ]);
    });

    it('answers empty for a provider that is switched off, where resolve throws', () => {
      // The property a card read depends on: a row written while a provider
      // was enabled must still read once it is not.
      const registry = registryWith([CardProviderKey.HYPERCARD]);

      expect(registry.capabilitiesOf(CardProviderKey.AXYS).size).toBe(0);
      expect(() => registry.resolve(CardProviderKey.AXYS)).toThrow(
        BadRequestException,
      );
    });
  });
});
