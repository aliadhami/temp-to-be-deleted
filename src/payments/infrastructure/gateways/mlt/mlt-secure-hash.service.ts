import { Injectable } from '@nestjs/common';
import { createCipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { buildMltSignaturePlainText } from './mlt-signature.util';

const AES_BLOCK_SIZE = 16;

@Injectable()
export class MltSecureHashService {
  /**
   * MLT's SecureHash is NOT standard AES-CBC/PKCS7. Per their spec
   * (Section 8, "SecureHashHelper.EncryptAES"):
   *  - key = SHA-256(secretKey)            -> 32 bytes, used as AES-256 key
   *  - IV  = 16 zero bytes                 -> fixed, per their reference code
   *  - padding: a custom scheme — the FIRST 16-byte block is reserved and
   *    its last 2 bytes hold the plaintext's bit-length (big-endian uint16);
   *    the actual plaintext bytes start at byte offset 16.
   * This is MLT's mandated wire protocol, not a scheme we chose — we
   * replicate it exactly so our hash matches what their PG independently
   * computes for verification.
   */
  private applyMltPadding(plainTextBytes: Buffer): Buffer {
    const outputLength =
      plainTextBytes.length % AES_BLOCK_SIZE === 0
        ? plainTextBytes.length + AES_BLOCK_SIZE
        : (Math.floor(plainTextBytes.length / AES_BLOCK_SIZE) + 2) *
          AES_BLOCK_SIZE;

    const output = Buffer.alloc(outputLength); // zero-filled by default
    const bitLength = plainTextBytes.length * 8;
    output.writeUInt8((bitLength >> 8) & 0xff, AES_BLOCK_SIZE - 2);
    output.writeUInt8(bitLength & 0xff, AES_BLOCK_SIZE - 1);
    plainTextBytes.copy(output, AES_BLOCK_SIZE);
    return output;
  }

  private encryptAes(plainText: string, secretKey: string): string {
    const key = createHash('sha256').update(secretKey, 'utf8').digest();
    const iv = Buffer.alloc(16); // zero IV, per MLT's reference implementation
    const padded = this.applyMltPadding(Buffer.from(plainText, 'utf8'));

    const cipher = createCipheriv('aes-256-cbc', key, iv);
    cipher.setAutoPadding(false); // MLT's padding is applied manually above
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
    return encrypted.toString('base64');
  }

  generate(
    fields: Record<string, string | undefined>,
    signatureFieldsCsv: string,
    secretKey: string,
  ): string {
    const plainText = buildMltSignaturePlainText(fields, signatureFieldsCsv);
    return this.encryptAes(plainText, secretKey);
  }

  verify(
    fields: Record<string, string | undefined>,
    signatureFieldsCsv: string,
    secretKey: string,
    providedHash: string,
  ): boolean {
    const expected = this.generate(fields, signatureFieldsCsv, secretKey);
    const expectedBuf = Buffer.from(expected, 'utf8');
    const providedBuf = Buffer.from(providedHash, 'utf8');
    if (expectedBuf.length !== providedBuf.length) return false;
    return timingSafeEqual(expectedBuf, providedBuf);
  }
}
