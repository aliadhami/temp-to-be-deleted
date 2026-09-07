import { GatewayCapability } from '../../../domain/gateway-capability.enum';
import { GatewayKey } from '../../../domain/gateway-key.enum';
import { PaymentIntent } from '../../../domain/payment-intent.model';
import { PaymentMethod } from '../../../domain/payment-method.enum';
import { GatewayCallbackContext } from '../../../domain/payment-gateway.port';
import { PaymentStatus } from '../../../domain/payment-status.enum';
import { SunPayHttpClient } from './sunpay-http-client.service';
import { SunPaySignatureService } from './sunpay-signature.service';
import { SunPayAdapter, toSunPayAmount } from './sunpay.adapter';
import {
  SunPayCryptoPayInCreateData,
  SunPayCryptoPayInQueryData,
  SunPayCryptoPayInRequest,
  SunPayWebhookPayload,
} from './sunpay.types';

const CREDENTIALS = {
  ENV: 'sandbox',
  SANDBOX_URL: 'https://sandbox-oapi.sunpay.pro',
  PROD_URL: 'https://oapi.sunpay.pro',
  API_KEY: 'pk_test',
  API_SECRET: 'secret',
  DEFAULT_CHAIN: 'TRON',
};

const intent = (overrides: Partial<PaymentIntent> = {}): PaymentIntent => ({
  publicId: 'pub-1',
  partnerId: '7',
  partnerPublicId: 'partner-uuid-1',
  gatewayKey: GatewayKey.SUNPAY,
  method: PaymentMethod.CRYPTO,
  amount: '20.00',
  currency: 'USDT',
  status: PaymentStatus.PENDING,
  refs: { requestId: 'REQ_1', referenceNumber: 'REF-1' },
  customer: {},
  callbackUrl: 'https://api.example.com/payments/callback/SUNPAY',
  ...overrides,
});

const CREATE_DATA: SunPayCryptoPayInCreateData = {
  order_no: 'O20250709194286513',
  out_order_no: 'REQ_1',
  payment_url: 'https://pay.sunpay.pro/checkout?k=abc',
  amount: 20,
  currency: 'USDT',
  address: 'TXqGztbmHUxd4jTfJVvbFWLRLCoj6qJra3',
  chain_type: 'TRON',
  expires_in: 3599,
};

describe('SunPayAdapter', () => {
  let httpClient: { post: jest.Mock; get: jest.Mock };
  let adapter: SunPayAdapter;

  let signatureService: SunPaySignatureService;

  beforeEach(() => {
    httpClient = { post: jest.fn(), get: jest.fn() };
    // The REAL signature service — webhook verification is security-critical, so
    // these tests must exercise the actual HMAC rather than a stub that says yes.
    signatureService = new SunPaySignatureService();
    adapter = new SunPayAdapter(
      httpClient as unknown as SunPayHttpClient,
      signatureService,
    );
  });

  /** Builds a callback context with a genuinely valid signature over the body. */
  const signedContext = (
    payload: SunPayWebhookPayload,
    secret = CREDENTIALS.API_SECRET,
  ): GatewayCallbackContext => {
    const rawBody = JSON.stringify(payload);
    const headers = signatureService.buildHeaders({
      apiKey: 'pk_test',
      apiSecret: secret,
      rawBody,
    });
    return {
      payload: payload as unknown as Record<string, unknown>,
      rawBody,
      // The controller lower-cases header names; mirror that here.
      headers: Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
      ),
    };
  };

  const webhook = (
    overrides: Partial<SunPayWebhookPayload['data']> = {},
    bizStatus = 'SUCCESS',
  ): SunPayWebhookPayload => ({
    biz_status: bizStatus,
    biz_type: 'PAYIN',
    data: {
      amount: 20,
      actual_payment_amount: 20,
      currency: 'TRC20_USDT',
      order_no: 'O20250709194286513',
      out_order_no: 'REQ_1',
      out_user_id: 'partner-uuid-1',
      ...overrides,
    },
  });

  /** Typed accessor for the body of a recorded POST — keeps assertions type-safe. */
  const postedBody = (callIndex = 0): SunPayCryptoPayInRequest => {
    const calls = httpClient.post.mock.calls as Array<
      [string, SunPayCryptoPayInRequest, unknown]
    >;
    const call = calls[callIndex];
    if (!call) throw new Error(`no POST recorded at index ${callIndex}`);
    return call[1];
  };

  describe('port contract', () => {
    it('identifies as SUNPAY and only advertises COLLECT', () => {
      expect(adapter.key).toBe(GatewayKey.SUNPAY);
      expect(adapter.capabilities.has(GatewayCapability.COLLECT)).toBe(true);
      expect(adapter.capabilities.has(GatewayCapability.PAYOUT)).toBe(false);
      expect(adapter.capabilities.has(GatewayCapability.REFUND)).toBe(false);
    });

    it('does not claim browser-delivered callbacks — SunPay is server-to-server', () => {
      expect(adapter.supportsBrowserRedirect).toBe(false);
    });

    it('acks webhooks with the exact JSON SunPay expects', () => {
      const ack = adapter.callbackAck();
      expect(ack.status).toBe(200);
      expect(JSON.parse(ack.body)).toEqual({
        is_success: 'true',
        message: 'success',
      });
    });
  });

  describe('initiate', () => {
    beforeEach(() => httpClient.post.mockResolvedValue(CREATE_DATA));

    it('posts the documented create-order body', async () => {
      await adapter.initiate(intent(), CREDENTIALS);

      expect(httpClient.post).toHaveBeenCalledWith(
        '/api/v3-1/Crypto/PayIn',
        {
          out_order_no: 'REQ_1',
          out_user_id: 'partner-uuid-1',
          amount: 20,
          chain_type: 'TRON',
          currency: 'USDT',
          webhook_url: 'https://api.example.com/payments/callback/SUNPAY',
        },
        expect.objectContaining({ apiKey: 'pk_test' }),
      );
    });

    it('sends the partner public UUID, never the internal id', async () => {
      await adapter.initiate(intent(), CREDENTIALS);
      const body = postedBody();
      expect(body.out_user_id).toBe('partner-uuid-1');
      expect(body.out_user_id).not.toBe('7');
    });

    it('uses the intent chainType when given, else the configured default', async () => {
      await adapter.initiate(intent({ chainType: 'ETH' }), CREDENTIALS);
      expect(postedBody().chain_type).toBe('ETH');

      httpClient.post.mockClear();
      await adapter.initiate(intent(), CREDENTIALS);
      expect(postedBody().chain_type).toBe('TRON');
    });

    it('returns a REDIRECT to payment_url and surfaces order_no as providerRef', async () => {
      const result = await adapter.initiate(intent(), CREDENTIALS);

      expect(result.kind).toBe('REDIRECT');
      expect(result.url).toBe(CREATE_DATA.payment_url);
      // Without this, queryStatus later has no id to look the order up by.
      expect(result.providerRef).toBe(CREATE_DATA.order_no);
    });

    it('exposes the deposit address in params so a QR needs no second call', async () => {
      const result = await adapter.initiate(intent(), CREDENTIALS);
      expect(result.params).toMatchObject({
        address: CREATE_DATA.address,
        chain_type: 'TRON',
        order_no: CREATE_DATA.order_no,
        expires_in: '3599',
      });
    });

    it('rejects a requestId SunPay would refuse, rather than silently mangling it', async () => {
      // SunPay allows letters/digits/underscore only — our own DTO is laxer.
      for (const bad of ['REQ-1', 'req.1', 'req 1', 'a'.repeat(65)]) {
        await expect(
          adapter.initiate(
            intent({ refs: { requestId: bad, referenceNumber: 'R' } }),
            CREDENTIALS,
          ),
        ).rejects.toThrow(/out_order_no/);
      }
      expect(httpClient.post).not.toHaveBeenCalled();
    });

    it('fails when the order is created but no payment_url comes back', async () => {
      httpClient.post.mockResolvedValue({ ...CREATE_DATA, payment_url: '' });
      await expect(adapter.initiate(intent(), CREDENTIALS)).rejects.toThrow(
        /no payment_url/,
      );
    });

    it('fails fast when credentials are incomplete', async () => {
      await expect(
        adapter.initiate(intent(), { ...CREDENTIALS, API_SECRET: '' }),
      ).rejects.toThrow(/API_SECRET/);
    });
  });

  describe('queryStatus', () => {
    const queryData = (
      overrides: Partial<SunPayCryptoPayInQueryData> = {},
    ): SunPayCryptoPayInQueryData => ({
      order_no: 'O20250709194286513',
      out_order_no: 'REQ_1',
      out_user_id: 'partner-uuid-1',
      amount: 20,
      order_status: 'SUCCESS',
      currency: 'USDT',
      chain_type: 'TRON',
      actual_payment_amount: 20,
      payment_url: 'https://pay.sunpay.pro/checkout?k=abc',
      to_address: 'TXqGztbmHUxd4jTfJVvbFWLRLCoj6qJra3',
      expires_in: 100,
      ...overrides,
    });

    it('queries by SunPay order_no, not our requestId', async () => {
      httpClient.get.mockResolvedValue(queryData());

      await adapter.queryStatus(
        {
          requestId: 'REQ_1',
          referenceNumber: 'REF-1',
          providerRef: 'O20250709194286513',
        },
        CREDENTIALS,
      );

      expect(httpClient.get).toHaveBeenCalledWith(
        '/api/v3-1/Crypto/PayIn/O20250709194286513',
        expect.anything(),
      );
    });

    it('throws when provider_ref was never stored', async () => {
      await expect(
        adapter.queryStatus(
          { requestId: 'REQ_1', referenceNumber: 'REF-1' },
          CREDENTIALS,
        ),
      ).rejects.toThrow(/no provider_ref/);
    });

    it.each([
      ['PENDING', PaymentStatus.PENDING],
      ['SUCCESS', PaymentStatus.PAID],
      ['CANCEL', PaymentStatus.CANCELLED],
    ])('maps order_status %s → %s', async (orderStatus, expected) => {
      httpClient.get.mockResolvedValue(
        queryData({ order_status: orderStatus }),
      );

      const result = await adapter.queryStatus(
        { requestId: 'R', referenceNumber: 'R', providerRef: 'O1' },
        CREDENTIALS,
      );
      expect(result.status).toBe(expected);
    });

    it('refuses to report PAID when SUCCESS arrives underpaid', async () => {
      httpClient.get.mockResolvedValue(
        queryData({ amount: 20, actual_payment_amount: 19.5 }),
      );

      const result = await adapter.queryStatus(
        { requestId: 'R', referenceNumber: 'R', providerRef: 'O1' },
        CREDENTIALS,
      );

      expect(result.status).toBe(PaymentStatus.ERROR);
      expect(result.status).not.toBe(PaymentStatus.PAID);
      expect(result.reasonCode).toBe('UNDERPAID');
      expect(result.message).toMatch(/expected 20 USDT, received 19\.5/);
    });

    it('still reports PAID on an overpayment', async () => {
      httpClient.get.mockResolvedValue(
        queryData({ amount: 20, actual_payment_amount: 25 }),
      );

      const result = await adapter.queryStatus(
        { requestId: 'R', referenceNumber: 'R', providerRef: 'O1' },
        CREDENTIALS,
      );
      expect(result.status).toBe(PaymentStatus.PAID);
    });
  });

  describe('extractRequestId', () => {
    it('reads our reference from the nested data.out_order_no', () => {
      // NOT top-level `RequestId` (MLT's shape). Getting this wrong means the
      // shared use-case finds no transaction, acks the webhook, and loses the
      // payment result permanently.
      expect(adapter.extractRequestId(signedContext(webhook()))).toBe('REQ_1');
    });

    it('returns null rather than guessing when the reference is absent', () => {
      for (const payload of [
        {},
        { data: {} },
        { data: { out_order_no: '' } },
        { RequestId: 'REQ_1' }, // MLT's field must NOT be accepted here
      ]) {
        expect(
          adapter.extractRequestId({
            payload: payload,
            rawBody: JSON.stringify(payload),
            headers: {},
          }),
        ).toBeNull();
      }
    });
  });

  describe('verifyResult', () => {
    it('accepts a correctly signed webhook and maps SUCCESS to PAID', async () => {
      const result = await adapter.verifyResult(
        signedContext(webhook()),
        CREDENTIALS,
      );

      expect(result.signatureValid).toBe(true);
      expect(result.status).toBe(PaymentStatus.PAID);
      expect(result.refs.providerRef).toBe('O20250709194286513');
    });

    it('maps FAIL to FAILED', async () => {
      const result = await adapter.verifyResult(
        signedContext(webhook({}, 'FAIL')),
        CREDENTIALS,
      );
      expect(result.signatureValid).toBe(true);
      expect(result.status).toBe(PaymentStatus.FAILED);
    });

    it('rejects a webhook signed with the wrong secret', async () => {
      const result = await adapter.verifyResult(
        signedContext(webhook(), 'attacker-secret'),
        CREDENTIALS,
      );

      expect(result.signatureValid).toBe(false);
      expect(result.status).not.toBe(PaymentStatus.PAID);
      expect(result.reasonCode).toBe('BAD_SIGNATURE');
    });

    it('rejects a webhook whose body was tampered with after signing', async () => {
      const context = signedContext(webhook());
      // Same headers/signature, mutated bytes — the classic forgery attempt.
      const tampered: GatewayCallbackContext = {
        ...context,
        rawBody: context.rawBody.replace('"amount":20', '"amount":2000'),
      };

      const result = await adapter.verifyResult(tampered, CREDENTIALS);
      expect(result.signatureValid).toBe(false);
      expect(result.reasonCode).toBe('BAD_SIGNATURE');
    });

    it.each([['sunpay-sign'], ['sunpay-timestamp'], ['sunpay-nonce']])(
      'rejects when the %s header is missing',
      async (header) => {
        const context = signedContext(webhook());
        const headers = { ...context.headers };
        delete headers[header];

        const result = await adapter.verifyResult(
          { ...context, headers },
          CREDENTIALS,
        );
        expect(result.signatureValid).toBe(false);
      },
    );

    it('refuses to report PAID when a signed SUCCESS webhook is underpaid', async () => {
      // The money bug this method exists to prevent: crypto lets the customer
      // send any amount, so biz_status SUCCESS is not proof of full payment.
      const result = await adapter.verifyResult(
        signedContext(webhook({ amount: 20, actual_payment_amount: 19.5 })),
        CREDENTIALS,
      );

      expect(result.signatureValid).toBe(true);
      expect(result.status).toBe(PaymentStatus.ERROR);
      expect(result.status).not.toBe(PaymentStatus.PAID);
      expect(result.reasonCode).toBe('UNDERPAID');
      expect(result.message).toMatch(/expected 20/);
    });

    it('still settles an overpayment as PAID', async () => {
      const result = await adapter.verifyResult(
        signedContext(webhook({ amount: 20, actual_payment_amount: 25 })),
        CREDENTIALS,
      );
      expect(result.status).toBe(PaymentStatus.PAID);
    });

    it('does not treat an unrecognised biz_status as paid', async () => {
      const result = await adapter.verifyResult(
        signedContext(webhook({}, 'PENDING')),
        CREDENTIALS,
      );
      // PENDING is a valid order_status but NOT a valid biz_status.
      expect(result.status).toBe(PaymentStatus.ERROR);
    });
  });

  describe('toSunPayAmount', () => {
    it('converts major-unit decimal strings to numbers', () => {
      expect(toSunPayAmount('20.00')).toBe(20);
      expect(toSunPayAmount('100.50')).toBe(100.5);
      expect(toSunPayAmount('0.01')).toBe(0.01);
    });

    it('rejects non-positive or malformed values', () => {
      for (const bad of ['0', '0.00', '-5.00', '', 'abc', '1e3', '20,00']) {
        expect(() => toSunPayAmount(bad)).toThrow();
      }
    });
  });
});
