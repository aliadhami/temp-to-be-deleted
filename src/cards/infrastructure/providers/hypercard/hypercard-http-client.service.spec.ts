import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { HyperCardHttpClient } from './hypercard-http-client.service';
import { HyperCardApiError } from './hypercard-response.util';
import { HyperCardSignatureService } from './hypercard-signature.service';
import { SECRETS_PROVIDER } from '../../../../secrets/domain/secrets-provider.port';
import type { SecretsProviderPort } from '../../../../secrets/domain/secrets-provider.port';

/** A fixed stand-in for what the (separately tested) signature service returns. */
const SIGNED_HEADERS = {
  timestamp: '1685351195',
  nonce: 'a1b2c3d4e5',
  'api-key': 'test-api-key',
  version: '1.0',
  lang: 'en',
  signature: 'ZmFrZS1zaWduYXR1cmU=',
};

const BASE_CONFIG: Record<string, string> = {
  PAYMENTS_HYPERCARD_BASE_URL: 'https://sandbox.hyperpay.io/',
};

const BASE_SECRETS: Record<string, string> = {
  'hypercard/api-key': 'test-api-key',
  'hypercard/signing-key': '-----BEGIN RSA PRIVATE KEY-----\n...',
};

/** Rebuilt per test, so a test that removes a key cannot leak into the next. */
let CONFIG: Record<string, string>;
let SECRETS: Record<string, string>;

describe('HyperCardHttpClient', () => {
  let client: HyperCardHttpClient;
  let configService: { getOrThrow: jest.Mock };
  let signatureService: { sign: jest.Mock };
  let getSecret: jest.Mock;
  let fetchMock: jest.SpyInstance;

  /** Their envelope, as it arrives off the wire. */
  const respondWith = (body: unknown, status = 200): void => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), { status }),
    );
  };

  // Jest types `mock.calls` as `any[]`; these narrow it once so the assertions
  // below stay type-checked.
  const fetchCall = (): [string, RequestInit] =>
    fetchMock.mock.calls[0] as unknown as [string, RequestInit];

  const firstSignedBody = (): unknown =>
    (signatureService.sign.mock.calls as unknown as unknown[][])[0]?.[0];

  beforeEach(async () => {
    CONFIG = { ...BASE_CONFIG };
    SECRETS = { ...BASE_SECRETS };

    // Mirrors the real getOrThrow: an absent key throws rather than yielding
    // undefined. PAYMENTS_HYPERCARD_BASE_URL is declared optional in
    // env.validation.ts and only required when the provider is enabled, so
    // "registered but unconfigured" is a live state for a disabled HyperCard.
    configService = {
      getOrThrow: jest.fn((key: string) => {
        const value = CONFIG[key];
        if (value === undefined) {
          throw new Error(`Configuration key "${key}" does not exist`);
        }
        return value;
      }),
    };
    signatureService = { sign: jest.fn(() => ({ ...SIGNED_HEADERS })) };

    // Mirrors the real SecretsProviderPort: an absent secret rejects rather
    // than resolving undefined.
    getSecret = jest.fn((path: string) => {
      const value = SECRETS[path];
      if (value === undefined) {
        return Promise.reject(new Error(`Vault secret "${path}" not found`));
      }
      return Promise.resolve(value);
    });
    const secretsProvider: Pick<SecretsProviderPort, 'getSecret'> = {
      getSecret,
    };

    // jest.spyOn calls through by default, so an unstubbed request would leave
    // this process and hit sandbox.hyperpay.io for real. Rejecting by default
    // makes any call a test forgot to queue fail loudly and locally instead.
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unstubbed fetch in a unit spec'));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HyperCardHttpClient,
        { provide: ConfigService, useValue: configService },
        { provide: HyperCardSignatureService, useValue: signatureService },
        { provide: SECRETS_PROVIDER, useValue: secretsProvider },
      ],
    }).compile();

    client = module.get(HyperCardHttpClient);
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  describe('key and config loading', () => {
    it('reads neither config nor secrets until the first request', () => {
      // The reason this client exists rather than a copy of AxysHttpClient:
      // that one reads its key material in onModuleInit, so a missing secret
      // breaks application boot even for a disabled provider.
      expect(configService.getOrThrow).not.toHaveBeenCalled();
      expect(getSecret).not.toHaveBeenCalled();
    });

    it('reads the signing key once and reuses it across requests', async () => {
      respondWith({ code: '00000', msg: 'ok', data: { ok: true } });
      respondWith({ code: '00000', msg: 'ok', data: { ok: true } });

      await client.post('merchant balance', '/openapi/card/merchant/balance', {
        coin: 'usdt',
      });
      await client.post('merchant balance', '/openapi/card/merchant/balance', {
        coin: 'usdt',
      });

      const signingKeyCalls = getSecret.mock.calls.filter(
        (call: unknown[]) => call[0] === 'hypercard/signing-key',
      );
      expect(signingKeyCalls).toHaveLength(1);
    });

    it('surfaces a missing env var on first use, and retries rather than caching the failure', async () => {
      delete CONFIG.PAYMENTS_HYPERCARD_BASE_URL;

      await expect(
        client.post('merchant balance', '/openapi/card/merchant/balance', {
          coin: 'usdt',
        }),
      ).rejects.toThrow('PAYMENTS_HYPERCARD_BASE_URL');
      expect(fetchMock).not.toHaveBeenCalled();

      // The half-resolved config must not have been cached: once the var is
      // supplied the next call has to succeed without a restart.
      CONFIG.PAYMENTS_HYPERCARD_BASE_URL = 'https://sandbox.hyperpay.io/';
      respondWith({ code: '00000', msg: 'ok', data: {} });

      await expect(
        client.post('merchant balance', '/openapi/card/merchant/balance', {
          coin: 'usdt',
        }),
      ).resolves.toEqual({});
    });

    it('surfaces a missing secret on first use, and retries rather than caching the failure', async () => {
      delete SECRETS['hypercard/api-key'];

      await expect(
        client.post('merchant balance', '/openapi/card/merchant/balance', {
          coin: 'usdt',
        }),
      ).rejects.toThrow('hypercard/api-key');
      expect(fetchMock).not.toHaveBeenCalled();

      SECRETS['hypercard/api-key'] = 'test-api-key';
      respondWith({ code: '00000', msg: 'ok', data: {} });

      await expect(
        client.post('merchant balance', '/openapi/card/merchant/balance', {
          coin: 'usdt',
        }),
      ).resolves.toEqual({});
    });

    it('strips a trailing slash from the configured base URL', async () => {
      respondWith({ code: '00000', msg: 'ok', data: {} });

      await client.post('merchant balance', '/openapi/card/merchant/balance', {
        coin: 'usdt',
      });

      expect(fetchCall()[0]).toBe(
        'https://sandbox.hyperpay.io/openapi/card/merchant/balance',
      );
    });
  });

  describe('request assembly', () => {
    it('sends the signed headers plus a JSON content type', async () => {
      respondWith({ code: '00000', msg: 'ok', data: {} });

      await client.post('merchant balance', '/openapi/card/merchant/balance', {
        coin: 'usdt',
      });

      const init = fetchCall()[1];
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({
        ...SIGNED_HEADERS,
        'Content-Type': 'application/json',
      });
    });

    it('signs the same object it serialises, and sends that one string', async () => {
      // The invariant: one object in, one JSON string out. If the body were
      // serialised again between signing and sending, the canonical string
      // HyperCard rebuilds could disagree with what we signed, and every call
      // would come back with their "Signature error" code.
      respondWith({ code: '00000', msg: 'ok', data: {} });
      const body = { coin: 'usdt' };

      await client.post(
        'merchant balance',
        '/openapi/card/merchant/balance',
        body,
      );

      expect(firstSignedBody()).toBe(body);
      expect(fetchCall()[1].body).toBe(JSON.stringify(body));
    });

    it('delegates signing entirely, passing the api key from Vault', async () => {
      respondWith({ code: '00000', msg: 'ok', data: {} });

      await client.post('merchant balance', '/openapi/card/merchant/balance', {
        coin: 'usdt',
      });

      expect(signatureService.sign).toHaveBeenCalledWith(
        { coin: 'usdt' },
        { apiKey: 'test-api-key' },
        '-----BEGIN RSA PRIVATE KEY-----\n...',
      );
    });
  });

  describe('response handling', () => {
    it('returns their data payload, never the envelope', async () => {
      // Their "Merchant Balance" endpoint's own documented sample response.
      respondWith({
        code: '00000',
        data: [{ amount: '100.00', coin: 'usdt', total_amount: '100.888888' }],
        msg: 'ok',
      });

      const data = await client.post(
        'merchant balance',
        '/openapi/card/merchant/balance',
        { coin: 'usdt' },
      );

      expect(data).toEqual([
        { amount: '100.00', coin: 'usdt', total_amount: '100.888888' },
      ]);
    });

    it('throws HyperCardApiError carrying their code on a failure', async () => {
      // Their "Signature error" code, from their response-error-code appendix.
      respondWith({ code: 'A0001', msg: 'Signature error' });

      await expect(
        client.post('merchant balance', '/openapi/card/merchant/balance', {
          coin: 'usdt',
        }),
      ).rejects.toMatchObject({
        name: 'HyperCardApiError',
        code: 'A0001',
        httpStatus: 200,
      });
    });

    it('throws HyperCardApiError rather than a parse error on a non-JSON body', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('<html>Forbidden</html>', { status: 403 }),
      );

      await expect(
        client.post('merchant balance', '/openapi/card/merchant/balance', {
          coin: 'usdt',
        }),
      ).rejects.toBeInstanceOf(HyperCardApiError);
    });

    it('normalises a transport failure into HyperCardApiError', async () => {
      // The TLS reset we currently get from their sandbox arrives as a
      // TypeError from fetch, not as a response. It must not escape raw.
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(
        client.post('merchant balance', '/openapi/card/merchant/balance', {
          coin: 'usdt',
        }),
      ).rejects.toMatchObject({
        name: 'HyperCardApiError',
        code: 'TRANSPORT_ERROR',
        httpStatus: 0,
      });
    });

    it('accepts an acknowledgement-only success through postForAck', async () => {
      // Their "Card operation request" endpoint's documented success response.
      respondWith({ code: '00000', msg: 'ok' });

      await expect(
        client.postForAck('card operation request', '/openapi/card/operation', {
          card_id: 'C1',
          request_number: 'R1',
          type: 1,
        }),
      ).resolves.toBeUndefined();
    });

    it('rejects an acknowledgement-only failure through postForAck', async () => {
      // Their "Card no existed" code.
      respondWith({ code: 'A0004', msg: 'Card no existed' });

      await expect(
        client.postForAck('card operation request', '/openapi/card/operation', {
          card_id: 'C1',
          request_number: 'R1',
          type: 1,
        }),
      ).rejects.toMatchObject({ code: 'A0004' });
    });

    it('returns the payload through postForOptionalData when one is present', async () => {
      // Their "Mock Add Balance" documented success payload.
      respondWith({
        code: '00000',
        msg: 'ok',
        data: [{ coin: 'usdt', balance: '100000.00000000' }],
      });

      await expect(
        client.postForOptionalData(
          'mock add balance',
          '/openapi/card/mock/add/balance',
          {},
        ),
      ).resolves.toEqual([{ coin: 'usdt', balance: '100000.00000000' }]);
    });

    it('returns null through postForOptionalData on a success with no payload', async () => {
      // Their "Mock Add Balance" page documents this as "call again", not as a
      // failure — so it must not become the error `post` would raise here.
      respondWith({ code: '00000', msg: 'ok' });

      await expect(
        client.postForOptionalData(
          'mock add balance',
          '/openapi/card/mock/add/balance',
          {},
        ),
      ).resolves.toBeNull();
    });

    it('still rejects a failure code through postForOptionalData', async () => {
      // Their "Card no existed" code — a plain failure, not one of the
      // conflict codes that get translated to a domain error.
      respondWith({ code: 'A0004', msg: 'Card no existed' });

      await expect(
        client.postForOptionalData(
          'mock add balance',
          '/openapi/card/mock/add/balance',
          {},
        ),
      ).rejects.toMatchObject({ code: 'A0004' });
    });
  });
});
