import { Injectable } from '@nestjs/common';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * SunPay's required request headers, exactly as they appear on the wire.
 *
 * `GatewayKey.SUNPAY` is the canonical identifier and propagates by derivation:
 * it drives the `PAYMENTS_SUNPAY_*` env prefix read by CredentialResolver and
 * the `/payments/callback/SUNPAY` path registered in their merchant portal.
 */
export const SUNPAY_HEADERS = {
  KEY: 'SunPay-Key',
  TIMESTAMP: 'SunPay-Timestamp',
  NONCE: 'SunPay-Nonce',
  SIGN: 'SunPay-Sign',
} as const;

/** Per spec: 32 characters, letters only (a–z, A–Z) — no digits. */
const NONCE_LENGTH = 32;
const NONCE_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export interface SunPaySignatureInput {
  timestamp: string;
  nonce: string;
  /**
   * The EXACT request/response body bytes as they go over the wire — never a
   * re-serialized object. Empty string for bodyless requests (GET), which
   * naturally reduces the signed payload to `timestamp + nonce` as the spec
   * requires.
   */
  rawBody: string;
  apiSecret: string;
}

export interface SunPaySignedHeaders {
  [SUNPAY_HEADERS.KEY]: string;
  [SUNPAY_HEADERS.TIMESTAMP]: string;
  [SUNPAY_HEADERS.NONCE]: string;
  [SUNPAY_HEADERS.SIGN]: string;
}

/**
 * SunPay request/webhook signing.
 *
 * The scheme is HMAC-SHA256 over `timestamp + nonce + rawBody`, keyed with the
 * merchant's API Secret, rendered as UPPERCASE hex. It is **symmetric** — the
 * same API Secret both signs our outbound requests and verifies their inbound
 * webhooks. There is no keypair here: no merchant private key, no platform
 * public key, no PEM material. (Axys, a different provider in this codebase,
 * *is* RSA-based — don't carry assumptions across from it.)
 *
 * The secret is a per-call argument rather than constructor-injected config
 * because a partner may supply their own SunPay credentials, resolved
 * per-transaction by CredentialResolver.
 */
@Injectable()
export class SunPaySignatureService {
  /** Unix milliseconds, as the string that must appear in both header and signed payload. */
  currentTimestamp(): string {
    return Date.now().toString();
  }

  generateNonce(): string {
    let nonce = '';
    for (let index = 0; index < NONCE_LENGTH; index += 1) {
      // randomInt is CSPRNG-backed and rejection-samples, so no modulo bias.
      nonce += NONCE_ALPHABET.charAt(randomInt(NONCE_ALPHABET.length));
    }
    return nonce;
  }

  /**
   * The exact string that gets HMAC'd: the three parts joined with no
   * separators, no newlines, in this order. Deliberately NOT sorted and not
   * canonicalized — SunPay signs the body verbatim, so re-ordering or
   * re-serializing it produces a signature their platform will reject.
   */
  buildSigningPayload(timestamp: string, nonce: string, rawBody = ''): string {
    return `${timestamp}${nonce}${rawBody}`;
  }

  sign(input: SunPaySignatureInput): string {
    const payload = this.buildSigningPayload(
      input.timestamp,
      input.nonce,
      input.rawBody,
    );
    return createHmac('sha256', input.apiSecret)
      .update(payload, 'utf8')
      .digest('hex')
      .toUpperCase();
  }

  /** Builds all four headers for an outbound request. Timestamp/nonce are generated unless supplied. */
  buildHeaders(input: {
    apiKey: string;
    apiSecret: string;
    rawBody: string;
    timestamp?: string;
    nonce?: string;
  }): SunPaySignedHeaders {
    const timestamp = input.timestamp ?? this.currentTimestamp();
    const nonce = input.nonce ?? this.generateNonce();
    const signature = this.sign({
      timestamp,
      nonce,
      rawBody: input.rawBody,
      apiSecret: input.apiSecret,
    });

    return {
      [SUNPAY_HEADERS.KEY]: input.apiKey,
      [SUNPAY_HEADERS.TIMESTAMP]: timestamp,
      [SUNPAY_HEADERS.NONCE]: nonce,
      [SUNPAY_HEADERS.SIGN]: signature,
    };
  }

  /**
   * Verifies a presented signature in constant time. Returns false rather than
   * throwing on any malformed input — a forged callback is an expected
   * condition, not an exceptional one.
   *
   * Comparison is case-insensitive: the spec mandates uppercase hex, and
   * normalizing costs nothing while surviving a provider that ever sends
   * lowercase. Hex case carries no secret, so this leaks nothing.
   */
  verify(
    input: SunPaySignatureInput & { presentedSignature: string },
  ): boolean {
    if (!input.presentedSignature) return false;

    const expected = Buffer.from(this.sign(input), 'utf8');
    const presented = Buffer.from(
      input.presentedSignature.trim().toUpperCase(),
      'utf8',
    );

    // timingSafeEqual throws on length mismatch, so guard first. Length is not
    // secret (it's a fixed-width hash), so an early return here is safe.
    if (expected.length !== presented.length) return false;
    return timingSafeEqual(expected, presented);
  }
}
