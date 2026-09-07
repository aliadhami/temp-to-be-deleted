import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended for GCM
const AUTH_TAG_LENGTH = 16;

@Injectable()
export class CredentialEncryptionService {
  private readonly key: Buffer;

  constructor(configService: ConfigService) {
    const rawKey = configService.getOrThrow<string>(
      'CREDENTIALS_ENCRYPTION_KEY',
    );
    // Derive a fixed 32-byte key regardless of input length/encoding
    this.key =
      Buffer.from(rawKey, 'hex').length === 32
        ? Buffer.from(rawKey, 'hex')
        : Buffer.from(rawKey.padEnd(32, '0').slice(0, 32));
  }

  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    // Store as: iv || authTag || ciphertext — self-contained, no separate column needed
    return Buffer.concat([iv, authTag, encrypted]);
  }

  decrypt(blob: Buffer): string {
    const iv = blob.subarray(0, IV_LENGTH);
    const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }
}
