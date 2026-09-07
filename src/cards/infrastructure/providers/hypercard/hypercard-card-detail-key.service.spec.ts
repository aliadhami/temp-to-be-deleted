import { generateKeyPairSync } from 'node:crypto';
import { inspect } from 'node:util';
import { Test, TestingModule } from '@nestjs/testing';
import {
  HYPERCARD_CARD_DETAIL_MIN_MODULUS_BITS,
  HyperCardCardDetailCryptoError,
} from './hypercard-card-detail.crypto';
import { HyperCardCardDetailKeyService } from './hypercard-card-detail-key.service';
import { SECRETS_PROVIDER } from '../../../../secrets/domain/secrets-provider.port';
import type { SecretsProviderPort } from '../../../../secrets/domain/secrets-provider.port';

/** A key in memory — this class exists to parse one, not to read a file. */
const generatePemKey = (modulusLength: number): string => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return privateKey;
};

describe('HyperCardCardDetailKeyService', () => {
  let getSecret: jest.Mock;

  const serviceFor = async (
    pem: string | undefined,
  ): Promise<HyperCardCardDetailKeyService> => {
    getSecret = jest.fn((path: string) => {
      if (pem === undefined) {
        return Promise.reject(new Error(`Vault secret "${path}" not found`));
      }
      return Promise.resolve(pem);
    });

    const secretsProvider: Pick<SecretsProviderPort, 'getSecret'> = {
      getSecret,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HyperCardCardDetailKeyService,
        { provide: SECRETS_PROVIDER, useValue: secretsProvider },
      ],
    }).compile();

    return module.get(HyperCardCardDetailKeyService);
  };

  // Generated once — 4096 bits is the smallest their page permits, and every
  // accepting case wants the same key.
  let validKeyPem: string;

  beforeAll(() => {
    validKeyPem = generatePemKey(HYPERCARD_CARD_DETAIL_MIN_MODULUS_BITS);
  });

  it('reads nothing until a reveal actually asks for a key', () => {
    // The whole reason this class has no lifecycle hook. `AxysHttpClient` reads
    // its keys in `onModuleInit` and so breaks application boot when its
    // provider is switched off — that is a defect, not a pattern, and this is
    // the assertion that keeps this class off it.
    void serviceFor(undefined);

    expect(getSecret).not.toHaveBeenCalled();
  });

  it('resolves both halves and caches them', async () => {
    const service = await serviceFor(validKeyPem);

    const first = await service.resolve();
    const second = await service.resolve();

    expect(first.publicKeyBase64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(second).toBe(first);
    // Cached: Vault is read once however many reveals run.
    expect(getSecret).toHaveBeenCalledTimes(1);
  });

  it('keeps the private half as a KeyObject with no printable form', async () => {
    const service = await serviceFor(validKeyPem);

    const { privateKey } = await service.resolve();

    // A `KeyObject` cannot be interpolated into a log line or an error message
    // by accident, which is why the private half never becomes a string here.
    expect(typeof privateKey).toBe('object');
    expect(inspect(privateKey)).not.toMatch(/PRIVATE KEY/);
  });

  it('refuses a key smaller than their endpoint requires', async () => {
    // A weak key stored under the same Vault path is the mistake most
    // available to make, and it would otherwise surface as an encryption
    // failure on their side rather than as a configuration error on ours.
    const service = await serviceFor(generatePemKey(1024));

    await expect(service.resolve()).rejects.toThrow(
      HyperCardCardDetailCryptoError,
    );
  });

  it('surfaces a Vault read failure rather than resolving a broken key pair', async () => {
    const service = await serviceFor(undefined);

    await expect(service.resolve()).rejects.toThrow(/not found/);
  });
});
