import { inspect } from 'node:util';
import {
  RevealedCardDetail,
  SensitiveCardDetails,
} from './sensitive-card-details';

describe('SensitiveCardDetails', () => {
  const details = new SensitiveCardDetails({
    kind: 'FULL',
    maskedPan: '************4242',
    cvv: '123',
    expiryMonth: 8,
    expiryYear: 2029,
  });

  it('exposes the raw values only via .expose()', () => {
    expect(details.expose()).toEqual({
      kind: 'FULL',
      maskedPan: '************4242',
      cvv: '123',
      expiryMonth: 8,
      expiryYear: 2029,
    });
  });

  it('throws on JSON.stringify instead of leaking data', () => {
    expect(() => JSON.stringify(details)).toThrow(
      /must never be JSON-serialized/,
    );
  });

  it('redacts on toString', () => {
    expect(details.toString()).toBe('[SensitiveCardDetails: redacted]');
    // The implicit path a template literal or a string concatenation takes,
    // reached through `String()` because the lint rules forbid writing either
    // against a class — which is itself part of the defence this asserts.
    expect(String(details)).toBe('[SensitiveCardDetails: redacted]');
  });

  it('redacts on util.inspect (console.log path)', () => {
    expect(inspect(details)).toBe('[SensitiveCardDetails: redacted]');
  });

  // Every arm gets the same treatment, because the leak-resistance is the whole
  // reason the union went inside this class rather than replacing it. The
  // hosted-page arm carries no card data and still must not serialise: its
  // password opens a page that shows one.
  const arms: RevealedCardDetail[] = [
    {
      kind: 'FULL',
      maskedPan: '624673******6680',
      pan: '6246731234566680',
      cvv: '123',
      expiryMonth: 4,
      expiryYear: 2025,
    },
    {
      kind: 'NUMBER_ONLY',
      maskedPan: '624673******6680',
      pan: '6246731234566680',
    },
    {
      kind: 'HOSTED_PAGE',
      url: 'https://example.test/card',
      password: '888888',
    },
    {
      kind: 'CARDHOLDER_DIRECT',
      maskedPan: '624673******6680',
      pan: '6246731234566680',
    },
  ];

  it.each(arms)('wraps the $kind arm without leaking it', (arm) => {
    const wrapped = new SensitiveCardDetails(arm);

    expect(wrapped.expose()).toEqual(arm);
    expect(() => JSON.stringify(wrapped)).toThrow(
      /must never be JSON-serialized/,
    );
    expect(wrapped.toString()).toBe('[SensitiveCardDetails: redacted]');
  });
});
