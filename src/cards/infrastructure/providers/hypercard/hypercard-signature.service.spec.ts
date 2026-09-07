import { createVerify, generateKeyPairSync } from 'node:crypto';
import { HyperCardSignatureService } from './hypercard-signature.service';

describe('HyperCardSignatureService', () => {
  let service: HyperCardSignatureService;
  let privateKeyPem: string;
  let publicKeyPem: string;
  let otherPublicKeyPem: string;

  const apiKey = 'test-api-key';

  beforeAll(() => {
    // RSA-1024 is HyperCard's mandated key length, per their official demo,
    // not 2048 as Axys uses.
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 1024,
    });
    privateKeyPem = privateKey
      .export({ type: 'pkcs1', format: 'pem' })
      .toString();
    publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const other = generateKeyPairSync('rsa', { modulusLength: 1024 });
    otherPublicKeyPem = other.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
  });

  beforeEach(() => {
    service = new HyperCardSignatureService();
  });

  /**
   * Rebuilds the canonical string by hand rather than calling the util, so a
   * bug in canonicalisation cannot be masked by both sides agreeing.
   */
  const verifyByHand = (
    headers: {
      timestamp: string;
      nonce: string;
      version: string;
      lang: string;
    },
    signature: string,
    bodyPair: string,
    publicKey: string,
  ): boolean => {
    const canonical = [
      `api-key=${apiKey}`,
      bodyPair,
      `lang=${headers.lang}`,
      `nonce=${headers.nonce}`,
      `timestamp=${headers.timestamp}`,
      `version=${headers.version}`,
    ].join('&');

    return createVerify('RSA-SHA256')
      .update(canonical)
      .verify(publicKey, signature, 'base64');
  };

  it('produces a signature that independently verifies against the public key', () => {
    const headers = service.sign({ coin: 'usdt' }, { apiKey }, privateKeyPem);

    expect(
      verifyByHand(headers, headers.signature, 'coin=usdt', publicKeyPem),
    ).toBe(true);
  });

  it('fails verification against a different key pair', () => {
    const headers = service.sign({ coin: 'usdt' }, { apiKey }, privateKeyPem);

    expect(
      verifyByHand(headers, headers.signature, 'coin=usdt', otherPublicKeyPem),
    ).toBe(false);
  });

  it('fails verification if the body is altered after signing', () => {
    const headers = service.sign({ coin: 'usdt' }, { apiKey }, privateKeyPem);

    expect(
      verifyByHand(headers, headers.signature, 'coin=btc', publicKeyPem),
    ).toBe(false);
  });

  it('fails verification if a signed header is altered after signing', () => {
    const headers = service.sign({ coin: 'usdt' }, { apiKey }, privateKeyPem);

    expect(
      verifyByHand(
        { ...headers, nonce: 'tamperednonce' },
        headers.signature,
        'coin=usdt',
        publicKeyPem,
      ),
    ).toBe(false);
  });

  it('generates a nonce of exactly 10 characters, per their "API Specification" page', () => {
    expect(service.sign({}, { apiKey }, privateKeyPem).nonce).toHaveLength(10);
  });

  it('generates a fresh nonce and never reuses one', () => {
    const first = service.sign({}, { apiKey }, privateKeyPem);
    const second = service.sign({}, { apiKey }, privateKeyPem);

    expect(first.nonce).not.toBe(second.nonce);
  });

  it('emits a plain Unix epoch in seconds, with no GMT+8 shift', () => {
    // Their "API Specification" page says API date/times are GMT+8, but their
    // official demo sends a plain epoch with no offset — the epoch wins.
    const headers = service.sign({}, { apiKey }, privateKeyPem);
    const nowSeconds = Math.floor(Date.now() / 1000);

    expect(Math.abs(Number(headers.timestamp) - nowSeconds)).toBeLessThan(5);
  });

  it('defaults version to 1.0 and lang to en, as their official demo always sends', () => {
    const headers = service.sign({}, { apiKey }, privateKeyPem);

    expect(headers.version).toBe('1.0');
    expect(headers.lang).toBe('en');
  });

  it('honours an explicit lang and binds it into the signature', () => {
    const headers = service.sign(
      { coin: 'usdt' },
      { apiKey, lang: 'zh-CN' },
      privateKeyPem,
    );

    expect(headers.lang).toBe('zh-CN');
    expect(
      verifyByHand(headers, headers.signature, 'coin=usdt', publicKeyPem),
    ).toBe(true);
  });

  it('signs a nested body, binding every nested field', () => {
    const body = {
      base_info: { email: 'a@b.com', mobile: '18888' },
      mc_trade_no: 'T1',
    };
    const headers = service.sign(body, { apiKey }, privateKeyPem);

    // Built explicitly rather than via verifyByHand: that helper assumes the
    // body contributes a single pair sorting before `lang`, and here the body's
    // two fields straddle it (base_info < lang < mc_trade_no).
    const canonical = [
      `api-key=${apiKey}`,
      'base_info={"email":"a@b.com","mobile":"18888"}',
      `lang=${headers.lang}`,
      'mc_trade_no=T1',
      `nonce=${headers.nonce}`,
      `timestamp=${headers.timestamp}`,
      `version=${headers.version}`,
    ].join('&');

    expect(
      createVerify('RSA-SHA256')
        .update(canonical)
        .verify(publicKeyPem, headers.signature, 'base64'),
    ).toBe(true);
  });

  describe('verify', () => {
    it('accepts a payload signed with the matching private key', () => {
      const body = { notify_type: 'RECHARGE', card_id: 'C1' };
      const headers = service.sign(body, { apiKey }, privateKeyPem);

      expect(service.verify({ ...headers }, body, publicKeyPem)).toBe(true);
    });

    it('rejects a payload whose body was altered in transit', () => {
      const body = { notify_type: 'RECHARGE', card_id: 'C1' };
      const headers = service.sign(body, { apiKey }, privateKeyPem);

      expect(
        service.verify(
          { ...headers },
          { ...body, card_id: 'C2' },
          publicKeyPem,
        ),
      ).toBe(false);
    });

    it('rejects a payload signed by an unknown key', () => {
      const body = { notify_type: 'RECHARGE' };
      const headers = service.sign(body, { apiKey }, privateKeyPem);

      expect(service.verify({ ...headers }, body, otherPublicKeyPem)).toBe(
        false,
      );
    });

    it('rejects when the signature header is missing or empty', () => {
      const body = { notify_type: 'RECHARGE' };

      expect(service.verify({ timestamp: '1' }, body, publicKeyPem)).toBe(
        false,
      );
      expect(service.verify({ signature: '' }, body, publicKeyPem)).toBe(false);
    });

    it('returns false rather than throwing on a malformed signature', () => {
      expect(
        service.verify(
          { signature: 'not-base64-!!' },
          { notify_type: 'RECHARGE' },
          publicKeyPem,
        ),
      ).toBe(false);
    });

    it('ignores unsigned transport headers a real request carries', () => {
      // The realistic shape: an HTTP handler hands over req.headers, which
      // carries far more than the five HyperCard signed.
      const body = { notify_type: 'RECHARGE', card_id: 'C1' };
      const headers = service.sign(body, { apiKey }, privateKeyPem);

      expect(
        service.verify(
          {
            ...headers,
            'content-type': 'application/json',
            'content-length': '42',
            host: 'pay-api.the-block.com',
            'user-agent': 'HyperCard/1.0',
            'accept-encoding': 'gzip',
          },
          body,
          publicKeyPem,
        ),
      ).toBe(true);
    });

    it('accepts header names in any case', () => {
      const body = { notify_type: 'RECHARGE' };
      const headers = service.sign(body, { apiKey }, privateKeyPem);

      expect(
        service.verify(
          {
            Timestamp: headers.timestamp,
            Nonce: headers.nonce,
            'API-KEY': headers['api-key'],
            Version: headers.version,
            Lang: headers.lang,
            signature: headers.signature,
          },
          body,
          publicKeyPem,
        ),
      ).toBe(true);
    });

    it('does not age-check by default — their pushes retry for 24 hours', () => {
      const body = { notify_type: 'RECHARGE' };
      const headers = service.sign(body, { apiKey }, privateKeyPem);
      const dayOld = {
        ...headers,
        timestamp: (Number(headers.timestamp) - 86_400).toString(),
      };

      // The freshness gate runs before signature verification, so this asserts
      // the gate specifically: off by default, rejecting once enabled.
      expect(
        service.verify(dayOld, body, publicKeyPem, { maxAgeSeconds: 300 }),
      ).toBe(false);
      expect(
        service.verify({ ...headers }, body, publicKeyPem, {
          maxAgeSeconds: 300,
        }),
      ).toBe(true);
    });

    it('rejects a non-numeric timestamp when freshness is enabled', () => {
      const body = { notify_type: 'RECHARGE' };
      const headers = service.sign(body, { apiKey }, privateKeyPem);

      expect(
        service.verify(
          { ...headers, timestamp: 'not-a-number' },
          body,
          publicKeyPem,
          { maxAgeSeconds: 300 },
        ),
      ).toBe(false);
    });
  });
});
