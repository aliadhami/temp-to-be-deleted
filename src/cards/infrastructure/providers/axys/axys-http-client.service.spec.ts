// src/cards/infrastructure/providers/axys/axys-http-client.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'node:events';
import { AxysHttpClient } from './axys-http-client.service';
import { AxysSignatureService } from './axys-signature.service';
import { SECRETS_PROVIDER } from '../../../../secrets/domain/secrets-provider.port';
import type { SecretsProviderPort } from '../../../../secrets/domain/secrets-provider.port';
import { CardProviderKey } from '../../../domain/card-provider-key.enum';

// A fake `https.ClientRequest`/`IncomingMessage` pair, driven manually so no
// real socket is ever opened. `request()` only needs the subset of the
// EventEmitter contract it actually listens on.
class FakeRequest extends EventEmitter {
  write = jest.fn();
  end = jest.fn();
}
class FakeResponse extends EventEmitter {
  statusCode = 200;
}

let capturedRequestOptions: unknown;
let fakeReq: FakeRequest;
let fakeRes: FakeResponse;

jest.mock('node:https', () => ({
  Agent: jest.fn().mockImplementation((opts: unknown) => ({ __opts: opts })),
  request: jest.fn(
    (options: unknown, callback: (res: FakeResponse) => void) => {
      capturedRequestOptions = options;
      fakeReq = new FakeRequest();
      fakeRes = new FakeResponse();
      // Defer so `request()`'s Promise executor has already attached its
      // listeners before the response fires — mirrors real async I/O timing.
      queueMicrotask(() => callback(fakeRes));
      return fakeReq;
    },
  ),
}));

describe('AxysHttpClient', () => {
  let getSecret: jest.Mock;
  let sign: jest.Mock;

  const PEM_STUB = {
    chain: '-----BEGIN CERTIFICATE-----\nchain\n-----END CERTIFICATE-----\n',
    key: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n',
    signingKey:
      '-----BEGIN PRIVATE KEY-----\nsigning\n-----END PRIVATE KEY-----\n',
  };

  const buildClient = async (
    enabledProviders: string[],
  ): Promise<AxysHttpClient> => {
    getSecret = jest.fn((path: string) => {
      if (path === 'axys/mtls-chain') return Promise.resolve(PEM_STUB.chain);
      if (path === 'axys/mtls-private-key')
        return Promise.resolve(PEM_STUB.key);
      if (path === 'axys/request-signing-key')
        return Promise.resolve(PEM_STUB.signingKey);
      return Promise.reject(new Error(`unexpected secret path: ${path}`));
    });
    sign = jest.fn(() => ({
      'X-Timestamp': '1',
      'X-Nonce': 'nonce',
      'X-Signature': 'sig',
    }));

    const configValues: Record<string, unknown> = {
      PAYMENTS_ENABLED_CARD_PROVIDERS: enabledProviders,
      PAYMENTS_AXYS_BASE_URL: 'https://axys.example.test',
    };

    const configService = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key in configValues ? configValues[key] : fallback,
      ),
      getOrThrow: jest.fn((key: string) => {
        if (!(key in configValues)) throw new Error(`${key} is not set`);
        return configValues[key];
      }),
    };

    const secretsProvider: Pick<SecretsProviderPort, 'getSecret'> = {
      getSecret,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AxysHttpClient,
        { provide: ConfigService, useValue: configService },
        { provide: AxysSignatureService, useValue: { sign } },
        { provide: SECRETS_PROVIDER, useValue: secretsProvider },
      ],
    }).compile();

    return module.get(AxysHttpClient);
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('when Axys is not enabled', () => {
    it('reads nothing from Vault and builds no TLS agent', async () => {
      const client = await buildClient([]);
      await client.onModuleInit();

      expect(getSecret).not.toHaveBeenCalled();
    });

    it('refuses request() with a clear error rather than crashing on a null agent', async () => {
      const client = await buildClient([CardProviderKey.HYPERCARD]);
      await client.onModuleInit();

      await expect(client.request('GET', '/accounts')).rejects.toThrow(
        /Axys is not enabled/,
      );
    });
  });

  describe('when Axys is enabled', () => {
    it('fetches all three secrets from Vault exactly once and builds a TLS agent', async () => {
      const client = await buildClient([CardProviderKey.AXYS]);
      await client.onModuleInit();

      expect(getSecret).toHaveBeenCalledTimes(3);
      expect(getSecret).toHaveBeenCalledWith('axys/mtls-chain');
      expect(getSecret).toHaveBeenCalledWith('axys/mtls-private-key');
      expect(getSecret).toHaveBeenCalledWith('axys/request-signing-key');
    });

    it('signs and sends a request, resolving with the parsed JSON body', async () => {
      const client = await buildClient([CardProviderKey.AXYS]);
      await client.onModuleInit();

      const promise = client.request<{ ok: boolean }>('GET', '/accounts');

      // Let the mocked https.request's queued callback fire, then emit a
      // response body on the fake IncomingMessage.
      await Promise.resolve();
      fakeRes.emit('data', Buffer.from('{"ok":true}'));
      fakeRes.emit('end');

      const result = await promise;

      expect(result).toEqual({ status: 200, body: { ok: true } });
      expect(sign).toHaveBeenCalledWith(
        'GET',
        '/accounts',
        '',
        PEM_STUB.signingKey,
      );
      expect(capturedRequestOptions).toMatchObject({
        host: 'axys.example.test',
        method: 'GET',
        path: '/accounts',
        headers: expect.objectContaining({
          'X-Signature': 'sig',
          'X-Timestamp': '1',
          'X-Nonce': 'nonce',
        }),
      });
    });

    it('sends an Idempotency-Key header when one is provided', async () => {
      const client = await buildClient([CardProviderKey.AXYS]);
      await client.onModuleInit();

      const promise = client.request(
        'POST',
        '/accounts',
        { first_name: 'Jordan' },
        'account-abc123',
      );

      await Promise.resolve();
      fakeRes.emit('data', Buffer.from('{}'));
      fakeRes.emit('end');
      await promise;

      expect(capturedRequestOptions).toMatchObject({
        headers: expect.objectContaining({
          'Idempotency-Key': 'account-abc123',
        }),
      });
    });
  });
});
