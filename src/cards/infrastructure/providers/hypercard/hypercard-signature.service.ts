import { Injectable } from '@nestjs/common';
import { createSign, createVerify, randomBytes } from 'node:crypto';
import {
  buildHyperCardCanonicalString,
  HYPERCARD_SIGNATURE_FIELD,
  pickSignedHeaders,
} from './hypercard-signature.util';

/** Headers HyperCard requires on every request, per their "API Specification" page. */
export interface HyperCardSignedHeaders {
  timestamp: string;
  nonce: string;
  'api-key': string;
  version: string;
  lang: string;
  signature: string;
}

type HyperCardUnsignedHeaders = Omit<HyperCardSignedHeaders, 'signature'>;

export interface HyperCardSigningContext {
  apiKey: string;
  /** Defaults to '1.0', the only version their "API Specification" page documents. */
  version?: string;
  /** 'en' | 'zh-CN'. Defaults to 'en', which their official demo always sends. */
  lang?: string;
}

export interface HyperCardVerifyOptions {
  /**
   * Reject a payload whose `timestamp` is further than this many seconds from
   * now, in either direction.
   */
  maxAgeSeconds?: number;
}

const DEFAULT_VERSION = '1.0';
const DEFAULT_LANGUAGE = 'en';

@Injectable()
export class HyperCardSignatureService {
  /**
   * Signs an outbound request: SHA256WithRSA over the canonical string, base64
   * into the `signature` header. Their key length is RSA-1024, not 2048.
   */
  sign(
    body: Record<string, unknown>,
    context: HyperCardSigningContext,
    privateKeyPem: string,
  ): HyperCardSignedHeaders {
    // Built once and used for both signing and transmission, so the set we sign
    // and the set we send cannot drift apart.
    const headers: HyperCardUnsignedHeaders = {
      timestamp: Math.floor(Date.now() / 1000).toString(),
      // Their "API Specification" page requires a random 10-character string; 5 bytes of hex is exactly 10.
      nonce: randomBytes(5).toString('hex'),
      'api-key': context.apiKey,
      version: context.version ?? DEFAULT_VERSION,
      lang: context.lang ?? DEFAULT_LANGUAGE,
    };

    const signature = createSign('RSA-SHA256')
      .update(buildHyperCardCanonicalString(headers, body))
      .sign(privateKeyPem, 'base64');

    return { ...headers, signature };
  }

  /**
   * Verifies an inbound push event against HyperCard's platform public key.
   * Pushes are signed with the same scheme as requests, so the same canonical
   * string applies.
   */
  verify(
    headers: Record<string, unknown>,
    body: Record<string, unknown>,
    platformPublicKeyPem: string,
    options: HyperCardVerifyOptions = {},
  ): boolean {
    const signature = headers[HYPERCARD_SIGNATURE_FIELD];
    if (typeof signature !== 'string' || signature === '') return false;

    const signedHeaders = pickSignedHeaders(headers);

    if (options.maxAgeSeconds !== undefined) {
      const timestamp = Number(signedHeaders['timestamp']);
      if (!Number.isFinite(timestamp)) return false;
      const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
      if (ageSeconds > options.maxAgeSeconds) return false;
    }

    try {
      return createVerify('RSA-SHA256')
        .update(buildHyperCardCanonicalString(signedHeaders, body))
        .verify(platformPublicKeyPem, signature, 'base64');
    } catch {
      // A malformed key or non-base64 signature throws rather than returning
      // false. An unverifiable push is a rejected push, not a 500.
      return false;
    }
  }
}
