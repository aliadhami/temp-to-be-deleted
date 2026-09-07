import { generateKeyPairSync } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { SECRETS_PROVIDER } from '../../../../secrets/domain/secrets-provider.port';
import { HyperCardPlatformKeyService } from './hypercard-platform-key.service';

const publicKeyPem = (): string =>
  generateKeyPairSync('rsa', {
    modulusLength: 1024,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).publicKey;

describe('HyperCardPlatformKeyService', () => {
  let getSecret: jest.Mock;

  const serviceFor = async (
    secret: () => Promise<string>,
  ): Promise<HyperCardPlatformKeyService> => {
    getSecret = jest.fn(secret);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HyperCardPlatformKeyService,
        { provide: SECRETS_PROVIDER, useValue: { getSecret } },
      ],
    }).compile();

    return module.get(HyperCardPlatformKeyService);
  };

  let validKey: string;

  beforeAll(() => {
    validKey = publicKeyPem();
  });

  it('reads nothing until a callback actually arrives', async () => {
    // Why this class has no lifecycle hook: a deployment that does not run
    // this issuer still boots, and never reaches Vault for a secret it has no
    // use for.
    await serviceFor(() => Promise.resolve(validKey));

    expect(getSecret).not.toHaveBeenCalled();
  });

  it('resolves the key and caches it', async () => {
    const service = await serviceFor(() => Promise.resolve(validKey));

    const first = await service.resolve();
    const second = await service.resolve();

    expect(first).toContain('BEGIN PUBLIC KEY');
    expect(second).toBe(first);
    expect(getSecret).toHaveBeenCalledTimes(1);
    expect(getSecret).toHaveBeenCalledWith('hypercard/platform-public');
  });

  it('resolves concurrent first callbacks against one Vault read', async () => {
    const service = await serviceFor(() => Promise.resolve(validKey));

    const [first, second] = await Promise.all([
      service.resolve(),
      service.resolve(),
    ]);

    expect(first).toBe(second);
    expect(getSecret).toHaveBeenCalledTimes(1);
  });

  it('surfaces an unreadable secret rather than reading as a bad signature', async () => {
    // A secret Vault cannot hand us is our misconfiguration. Answering "the
    // signature did not verify" would send whoever diagnoses it into the
    // signing path instead.
    const service = await serviceFor(() =>
      Promise.reject(new Error('secret not found')),
    );

    await expect(service.resolve()).rejects.toThrow('secret not found');
  });

  it('does not cache a failed resolution', async () => {
    // A transient Vault outage must not become a permanent one for the life
    // of the process.
    const service = await serviceFor(() =>
      Promise.reject(new Error('vault unreachable')),
    );

    await expect(service.resolve()).rejects.toThrow('vault unreachable');

    getSecret.mockResolvedValueOnce(validKey);
    await expect(service.resolve()).resolves.toBe(validKey);
    expect(getSecret).toHaveBeenCalledTimes(2);
  });
});
