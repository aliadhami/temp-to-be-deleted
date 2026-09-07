import { createHmac } from 'node:crypto';
import {
  SUNPAY_HEADERS,
  SunPaySignatureService,
} from './sunpay-signature.service';

/**
 * Published reference vector from SunPay's own "Signature Auth" docs.
 * This is the anchor for the whole suite: if these four inputs stop producing
 * this exact signature, our signing no longer matches their platform and every
 * live request would be rejected.
 */
const VECTOR = {
  apiSecret: 'f4d44a66468da16953012d6ef0ca9be04205702058ca44f18497c6bce5e27746',
  timestamp: '1678854509192',
  nonce: 'aZkLpQmRnTsUvWxYbCdEfGhJkLmNpQrS',
  rawBody: '{"out_user_id":"123","currency":"USDT","amount":"100.50"}',
  expectedSignature:
    'E642F6785FEF21F508350C165D2D969E4D8AC9FA0CEAE06D3F8BE7CBC40CB149',
} as const;

describe('SunPaySignatureService', () => {
  let service: SunPaySignatureService;

  beforeEach(() => {
    service = new SunPaySignatureService();
  });

  describe('buildSigningPayload', () => {
    it('joins timestamp + nonce + body with no separators, in that order', () => {
      expect(
        service.buildSigningPayload(
          VECTOR.timestamp,
          VECTOR.nonce,
          VECTOR.rawBody,
        ),
      ).toBe(`${VECTOR.timestamp}${VECTOR.nonce}${VECTOR.rawBody}`);
    });

    it('reduces to timestamp + nonce when there is no body', () => {
      expect(service.buildSigningPayload(VECTOR.timestamp, VECTOR.nonce)).toBe(
        `${VECTOR.timestamp}${VECTOR.nonce}`,
      );
      expect(
        service.buildSigningPayload(VECTOR.timestamp, VECTOR.nonce, ''),
      ).toBe(`${VECTOR.timestamp}${VECTOR.nonce}`);
    });
  });

  describe('sign', () => {
    it("reproduces SunPay's published reference signature exactly", () => {
      expect(service.sign(VECTOR)).toBe(VECTOR.expectedSignature);
    });

    it('returns uppercase hex only', () => {
      expect(service.sign(VECTOR)).toMatch(/^[0-9A-F]{64}$/);
    });

    it('signs the body verbatim — key order is significant, not canonicalized', () => {
      // Same JSON semantically, keys reordered. A sorted/canonicalizing
      // implementation would wrongly produce an identical signature here.
      const reordered = service.sign({
        ...VECTOR,
        rawBody: '{"amount":"100.50","currency":"USDT","out_user_id":"123"}',
      });
      expect(reordered).not.toBe(VECTOR.expectedSignature);
    });

    it('is sensitive to insignificant whitespace, proving raw bytes are signed', () => {
      const respaced = service.sign({
        ...VECTOR,
        rawBody: '{"out_user_id": "123","currency":"USDT","amount":"100.50"}',
      });
      expect(respaced).not.toBe(VECTOR.expectedSignature);
    });

    it('omits the body from the payload when rawBody is empty (bodyless GET)', () => {
      const expected = createHmac('sha256', VECTOR.apiSecret)
        .update(`${VECTOR.timestamp}${VECTOR.nonce}`, 'utf8')
        .digest('hex')
        .toUpperCase();

      expect(service.sign({ ...VECTOR, rawBody: '' })).toBe(expected);
    });

    it('changes when any single input changes', () => {
      const base = service.sign(VECTOR);
      expect(service.sign({ ...VECTOR, timestamp: '1678854509193' })).not.toBe(
        base,
      );
      expect(
        service.sign({ ...VECTOR, nonce: 'bZkLpQmRnTsUvWxYbCdEfGhJkLmNpQrS' }),
      ).not.toBe(base);
      expect(
        service.sign({ ...VECTOR, apiSecret: VECTOR.apiSecret.slice(0, -1) }),
      ).not.toBe(base);
    });
  });

  describe('verify', () => {
    it('accepts the published signature', () => {
      expect(
        service.verify({
          ...VECTOR,
          presentedSignature: VECTOR.expectedSignature,
        }),
      ).toBe(true);
    });

    it('accepts a lowercase signature', () => {
      expect(
        service.verify({
          ...VECTOR,
          presentedSignature: VECTOR.expectedSignature.toLowerCase(),
        }),
      ).toBe(true);
    });

    it('tolerates surrounding whitespace from header parsing', () => {
      expect(
        service.verify({
          ...VECTOR,
          presentedSignature: `  ${VECTOR.expectedSignature}\n`,
        }),
      ).toBe(true);
    });

    it('rejects a tampered body', () => {
      expect(
        service.verify({
          ...VECTOR,
          rawBody: VECTOR.rawBody.replace('100.50', '900.50'),
          presentedSignature: VECTOR.expectedSignature,
        }),
      ).toBe(false);
    });

    it('rejects a signature made with a different secret', () => {
      const forged = service.sign({ ...VECTOR, apiSecret: 'wrong-secret' });
      expect(service.verify({ ...VECTOR, presentedSignature: forged })).toBe(
        false,
      );
    });

    it('rejects a replayed signature under a different timestamp or nonce', () => {
      expect(
        service.verify({
          ...VECTOR,
          timestamp: '1678854509999',
          presentedSignature: VECTOR.expectedSignature,
        }),
      ).toBe(false);
      expect(
        service.verify({
          ...VECTOR,
          nonce: 'zZkLpQmRnTsUvWxYbCdEfGhJkLmNpQrS',
          presentedSignature: VECTOR.expectedSignature,
        }),
      ).toBe(false);
    });

    it('returns false without throwing on malformed signatures', () => {
      for (const presentedSignature of [
        '',
        'not-hex',
        VECTOR.expectedSignature.slice(0, 32),
        `${VECTOR.expectedSignature}EXTRA`,
      ]) {
        expect(() =>
          service.verify({ ...VECTOR, presentedSignature }),
        ).not.toThrow();
        expect(service.verify({ ...VECTOR, presentedSignature })).toBe(false);
      }
    });
  });

  describe('generateNonce', () => {
    it('produces 32 letters, no digits or symbols', () => {
      expect(service.generateNonce()).toMatch(/^[a-zA-Z]{32}$/);
    });

    it('produces a distinct value per call', () => {
      const nonces = new Set(
        Array.from({ length: 200 }, () => service.generateNonce()),
      );
      expect(nonces.size).toBe(200);
    });
  });

  describe('buildHeaders', () => {
    it('emits all four headers with a signature matching the signed payload', () => {
      const headers = service.buildHeaders({
        apiKey: 'pk_live_abc123',
        apiSecret: VECTOR.apiSecret,
        rawBody: VECTOR.rawBody,
        timestamp: VECTOR.timestamp,
        nonce: VECTOR.nonce,
      });

      expect(headers).toEqual({
        [SUNPAY_HEADERS.KEY]: 'pk_live_abc123',
        [SUNPAY_HEADERS.TIMESTAMP]: VECTOR.timestamp,
        [SUNPAY_HEADERS.NONCE]: VECTOR.nonce,
        [SUNPAY_HEADERS.SIGN]: VECTOR.expectedSignature,
      });
    });

    it('generates a fresh timestamp and nonce when not supplied', () => {
      const before = Date.now();
      const headers = service.buildHeaders({
        apiKey: 'pk_test',
        apiSecret: VECTOR.apiSecret,
        rawBody: '{}',
      });

      const timestamp = Number(headers[SUNPAY_HEADERS.TIMESTAMP]);
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(Date.now());
      expect(headers[SUNPAY_HEADERS.NONCE]).toMatch(/^[a-zA-Z]{32}$/);
    });

    it('produces headers that verify against the same secret', () => {
      const rawBody = '{"out_order_no":"ORDER_1","amount":20}';
      const headers = service.buildHeaders({
        apiKey: 'pk_test',
        apiSecret: VECTOR.apiSecret,
        rawBody,
      });

      expect(
        service.verify({
          timestamp: headers[SUNPAY_HEADERS.TIMESTAMP],
          nonce: headers[SUNPAY_HEADERS.NONCE],
          rawBody,
          apiSecret: VECTOR.apiSecret,
          presentedSignature: headers[SUNPAY_HEADERS.SIGN],
        }),
      ).toBe(true);
    });
  });
});
