import { GatewayKey } from '../../../domain/gateway-key.enum';
import { PaymentMethod } from '../../../domain/payment-method.enum';
import { PaymentStatus } from '../../../domain/payment-status.enum';
import { PaymentIntent } from '../../../domain/payment-intent.model';
import { MltSecureHashService } from './mlt-secure-hash.service';
import { MltAdapter } from './mlt.adapter';

const ctx = (payload: Record<string, unknown>) => ({
  payload,
  rawBody: JSON.stringify(payload),
  headers: {} as Record<string, string>,
});

describe('MltAdapter', () => {
  let adapter: MltAdapter;
  const secureHashService = new MltSecureHashService();

  const credentials = {
    MERCHANT_ID: 'MERCHANT001',
    USER_ID: 'USER001',
    PASSWORD: 'encrypted-pw',
    SECRET_KEY: 'test-secret',
    ENV: 'uat',
    UAT_URL: 'https://thegateuat.theplatformomnipay.com',
    PAYMENT_CHANNEL: 'OCD',
  };

  const intent: PaymentIntent = {
    publicId: 'pub-1',
    partnerId: null,
    gatewayKey: GatewayKey.MLT,
    method: PaymentMethod.FIAT_CARD,
    amount: '10.00',
    currency: 'AED',
    status: PaymentStatus.PENDING,
    refs: { requestId: 'REQ-1', referenceNumber: 'REF-1' },
    customer: { name: 'Test User', email: 'test@example.com', country: 'AE' },
    callbackUrl: 'https://merchant.example.com/callback',
  };

  beforeEach(() => {
    adapter = new MltAdapter(secureHashService);
  });

  describe('initiate', () => {
    it('builds a FORM_POST result with a valid SecureHash', async () => {
      const result = await adapter.initiate(intent, credentials);

      expect(result.kind).toBe('FORM_POST');
      expect(result.url).toBe(
        'https://thegateuat.theplatformomnipay.com/Gateway/PG',
      );
      expect(result.params?.RequestId).toBe('REQ-1');
      expect(result.params?.Amount).toBe('10.00');

      const hashValid = secureHashService.verify(
        result.params as Record<string, string>,
        result.params?.SignatureFields ?? '',
        credentials.SECRET_KEY,
        result.params?.SecureHash ?? '',
      );
      expect(hashValid).toBe(true);
    });

    it('splits customer.name into FirstName/LastName', async () => {
      const result = await adapter.initiate(intent, credentials);
      expect(result.params?.FirstName).toBe('Test');
      expect(result.params?.LastName).toBe('User');
    });

    it('throws if neither UAT nor production URL is configured', async () => {
      await expect(
        adapter.initiate(intent, {
          ...credentials,
          UAT_URL: undefined as never,
        }),
      ).rejects.toThrow();
    });
  });

  describe('verifyResult', () => {
    it('rejects a callback with an invalid SecureHash', async () => {
      const result = await adapter.verifyResult(
        ctx({
          RequestId: 'REQ-1',
          ReferenceNumber: 'REF-1',
          TimeStamp: '09062026 14:35:10',
          MerchantId: 'MERCHANT001',
          Amount: '10.00',
          SignatureFields:
            'RequestId,TimeStamp,ReferenceNumber,MerchantId,Amount',
          SecureHash: 'not-a-real-hash',
          TransactionStatus: 'PAID',
        }),
        credentials,
      );
      expect(result.signatureValid).toBe(false);
    });

    it('accepts a callback with a valid SecureHash and maps status correctly', async () => {
      const fields = {
        RequestId: 'REQ-1',
        TimeStamp: '09062026 14:35:10',
        ReferenceNumber: 'REF-1',
        MerchantId: 'MERCHANT001',
        Amount: '10.00',
      };
      const signatureFields =
        'RequestId,TimeStamp,ReferenceNumber,MerchantId,Amount';
      const validHash = secureHashService.generate(
        fields,
        signatureFields,
        credentials.SECRET_KEY,
      );

      const result = await adapter.verifyResult(
        ctx({
          ...fields,
          SignatureFields: signatureFields,
          SecureHash: validHash,
          TransactionStatus: 'PAID',
        }),
        credentials,
      );

      expect(result.signatureValid).toBe(true);
      expect(result.status).toBe(PaymentStatus.PAID);
    });
  });

  describe('queryStatus', () => {
    it('throws — not yet supported per MLT spec', async () => {
      await expect(
        adapter.queryStatus(
          { requestId: 'REQ-1', referenceNumber: 'REF-1' },
          credentials,
        ),
      ).rejects.toThrow();
    });
  });

  describe('callbackAck', () => {
    it('returns 200 OK', () => {
      // contentType must stay text/plain: the body is the bare string `OK`,
      // and labelling it application/json breaks clients that parse by header.
      expect(adapter.callbackAck()).toEqual({
        status: 200,
        body: 'OK',
        contentType: 'text/plain',
      });
    });
  });
});
