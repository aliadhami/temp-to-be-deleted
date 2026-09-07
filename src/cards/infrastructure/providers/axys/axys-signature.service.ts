import { Injectable } from '@nestjs/common';
import { createHash, createSign, randomBytes } from 'node:crypto';

export interface AxysSignedHeaders {
  'X-Timestamp': string;
  'X-Nonce': string;
  'X-Signature': string;
}

@Injectable()
export class AxysSignatureService {
  /**
   * Builds the canonical five-line string per Axys spec §"Authentication":
   * METHOD, pathWithQuery, timestamp, nonce, lowercase-hex sha256(rawBody).
   * An empty body hashes as sha256 of the empty buffer.
   */
  private buildCanonicalString(
    method: string,
    pathWithQuery: string,
    timestamp: string,
    nonce: string,
    rawBody: string,
  ): string {
    const bodyHash = createHash('sha256').update(rawBody, 'utf8').digest('hex');
    return [
      method.toUpperCase(),
      pathWithQuery,
      timestamp,
      nonce,
      bodyHash,
    ].join('\n');
  }

  sign(
    method: string,
    pathWithQuery: string,
    rawBody: string,
    privateKeyPem: string,
  ): AxysSignedHeaders {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    // 16-128 chars required by spec; 18 random bytes -> 24 base64url chars, comfortably in range
    const nonce = randomBytes(18).toString('base64url');

    const canonical = this.buildCanonicalString(
      method,
      pathWithQuery,
      timestamp,
      nonce,
      rawBody,
    );
    const signature = createSign('RSA-SHA256')
      .update(canonical)
      .sign(privateKeyPem, 'base64');

    return {
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Signature': signature,
    };
  }
}
