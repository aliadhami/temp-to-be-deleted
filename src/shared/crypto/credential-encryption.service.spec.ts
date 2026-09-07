import { ConfigService } from '@nestjs/config';
import { CredentialEncryptionService } from './credential-encryption.service';

describe('CredentialEncryptionService', () => {
  let service: CredentialEncryptionService;

  beforeEach(() => {
    const configService = {
      getOrThrow: jest.fn(() => 'a'.repeat(64)), // valid 32-byte hex key
    } as unknown as ConfigService;
    service = new CredentialEncryptionService(configService);
  });

  it('decrypts back to the original plaintext', () => {
    const plaintext = JSON.stringify({ merchantId: 'ABC123', secretKey: 'shh' });
    const encrypted = service.encrypt(plaintext);
    expect(service.decrypt(encrypted)).toBe(plaintext);
  });

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    const plaintext = 'same-input';
    const first = service.encrypt(plaintext);
    const second = service.encrypt(plaintext);
    expect(first.equals(second)).toBe(false);
  });

  it('throws when the ciphertext has been tampered with', () => {
    const encrypted = service.encrypt('sensitive-value');
    const lastByteIndex = encrypted.length - 1;
    const lastByte = encrypted.readUInt8(lastByteIndex);
    encrypted.writeUInt8(lastByte ^ 0xff, lastByteIndex); // flip last byte
    expect(() => service.decrypt(encrypted)).toThrow();
  });
});
