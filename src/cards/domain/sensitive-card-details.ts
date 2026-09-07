/**
 * What an issuer hands over when a card's details are read.
 *
 * **`pan` and `maskedPan` are different fields and neither stands in for the
 * other** — a caller reading `maskedPan` must never receive an unmasked number.
 */
export type RevealedCardDetail =
  /**
   * Everything needed to use the card online. `pan` is optional here and only
   * here: absent means the issuer does not return the full number.
   */
  | {
      kind: 'FULL';
      maskedPan: string;
      pan?: string;
      cvv: string;
      expiryMonth: number;
      expiryYear: number;
    }
  /** The number alone — a complete answer, not a partial one. */
  | { kind: 'NUMBER_ONLY'; maskedPan: string; pan: string }
  /** A page the cardholder opens themselves. Nothing here proxies or stores it. */
  | {
      kind: 'HOSTED_PAGE';
      url: string;
      /** Entered on the page above, when the issuer sets one. */
      password?: string;
      /** ISO 8601. Absent when the issuer publishes no expiry for the page. */
      expiresAt?: string;
    }
  /**
   * The number, with the secrets delivered to the cardholder by the issuer.
   * Its own arm because at least one issuer fills its security-code field with
   * literal prose here, which is a lie typed as a card credential.
   */
  | { kind: 'CARDHOLDER_DIRECT'; maskedPan: string; pan: string };

/**
 * Wraps unmasked card details, and deliberately resists accidental leakage:
 * `toJSON()` throws, so `JSON.stringify()` — which underlies logging, error
 * reporters, caches and Nest's response serialization — fails loudly rather
 * than silently transmitting the raw values, and `toString()` returns a
 * redacted placeholder.
 *
 * The only way out is `.expose()`, called in exactly one place: the controller
 * building the response body.
 */
export class SensitiveCardDetails {
  constructor(private readonly detail: RevealedCardDetail) {}

  expose(): RevealedCardDetail {
    return this.detail;
  }

  toJSON(): never {
    throw new Error(
      'SensitiveCardDetails must never be JSON-serialized implicitly (logs, caches, error reporters, default HTTP responses). Call .expose() explicitly at the response boundary only.',
    );
  }

  toString(): string {
    return '[SensitiveCardDetails: redacted]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[SensitiveCardDetails: redacted]';
  }
}
