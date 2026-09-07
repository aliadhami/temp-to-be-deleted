import { MltSecureHashService } from './mlt-secure-hash.service';

describe('MltSecureHashService', () => {
  let service: MltSecureHashService;
  const secretKey = 'test-secret-key-for-uat';
  const signatureFields =
    'RequestId,TimeStamp,ReferenceNumber,MerchantId,Amount';
  const fields = {
    RequestId: 'REQ-TEST-0001',
    TimeStamp: '09062026 14:35:10',
    ReferenceNumber: 'TEST-REF-0001',
    MerchantId: 'MERCHANT001',
    Amount: '10.00',
  };

  beforeEach(() => {
    service = new MltSecureHashService();
  });

  it('is deterministic — same inputs always produce the same hash', () => {
    const first = service.generate(fields, signatureFields, secretKey);
    const second = service.generate(fields, signatureFields, secretKey);
    expect(first).toBe(second);
  });

  it('verify() succeeds against a hash generated from the same inputs', () => {
    const hash = service.generate(fields, signatureFields, secretKey);
    expect(service.verify(fields, signatureFields, secretKey, hash)).toBe(true);
  });

  it('verify() fails if any signed field value changes', () => {
    const hash = service.generate(fields, signatureFields, secretKey);
    const tamperedFields = { ...fields, Amount: '9999.00' };
    expect(
      service.verify(tamperedFields, signatureFields, secretKey, hash),
    ).toBe(false);
  });

  it('verify() fails against a completely different secret key', () => {
    const hash = service.generate(fields, signatureFields, secretKey);
    expect(service.verify(fields, signatureFields, 'wrong-secret', hash)).toBe(
      false,
    );
  });

  it('produces different hashes for different secret keys given the same fields', () => {
    const hashA = service.generate(fields, signatureFields, 'key-a');
    const hashB = service.generate(fields, signatureFields, 'key-b');
    expect(hashA).not.toBe(hashB);
  });

  it('produces a base64 string', () => {
    const hash = service.generate(fields, signatureFields, secretKey);
    expect(() => Buffer.from(hash, 'base64')).not.toThrow();
    expect(Buffer.from(hash, 'base64').toString('base64')).toBe(hash);
  });
});
