import { buildMltSignaturePlainText } from './mlt-signature.util';

describe('buildMltSignaturePlainText', () => {
  it("matches the exact plaintext from MLT's Section 6 worked example", () => {
    const fields = {
      RequestId: 'REQ-TEST-0001',
      TimeStamp: '09062026 14:35:10',
      ReferenceNumber: 'TEST-REF-0001',
      MerchantId: 'MERCHANT001',
      Amount: '10.00',
    };
    const signatureFields =
      'RequestId,TimeStamp,ReferenceNumber,MerchantId,Amount';

    const result = buildMltSignaturePlainText(fields, signatureFields);

    expect(result).toBe(
      'RequestId=REQ-TEST-0001,TimeStamp=09062026 14:35:10,ReferenceNumber=TEST-REF-0001,MerchantId=MERCHANT001,Amount=10.00',
    );
  });

  it('excludes fields that are missing or empty', () => {
    const result = buildMltSignaturePlainText(
      { RequestId: 'REQ-1', TimeStamp: '', ReferenceNumber: undefined },
      'RequestId,TimeStamp,ReferenceNumber',
    );
    expect(result).toBe('RequestId=REQ-1');
  });

  it('preserves the exact order given by SignatureFields, not object key order', () => {
    const fields = { Amount: '5.00', RequestId: 'R1' };
    const result = buildMltSignaturePlainText(fields, 'Amount,RequestId');
    expect(result).toBe('Amount=5.00,RequestId=R1');
  });
});
