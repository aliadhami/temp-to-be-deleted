import { CardProviderIntentRejectedError } from '../../../domain/card-provider-intent-rejected.error';
import { CardProviderKey } from '../../../domain/card-provider-key.enum';
import { CardholderIntent } from '../../../domain/cardholder-intent.model';
import { assertHyperCardBaseInfo } from './hypercard-base-info.util';

describe('assertHyperCardBaseInfo', () => {
  const intent: CardholderIntent = {
    publicId: '9f8c1e2a-4b7d-4c3e-8a51-6d2f0b9e7c14',
    partnerId: 'partner-1',
    providerKey: CardProviderKey.HYPERCARD,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    phone: '+441234567890',
    dateOfBirth: '1815-12-10',
    residentialAddress: {
      addressLine1: '1 Main St',
      city: 'London',
      country: 'GB',
    },
    identityProvenance: {
      nationality: 'British',
      placeOfBirth: 'GBR',
      gender: 1,
      callingCode: '44',
      countryCallingCode: 'GB',
      cellNumber: '1234567890',
    },
  };

  const withProvenance = (
    overrides: Partial<CardholderIntent['identityProvenance']>,
  ): CardholderIntent => ({
    ...intent,
    identityProvenance: { ...intent.identityProvenance, ...overrides },
  });

  it('accepts a cardholder their application would take', () => {
    expect(() => assertHyperCardBaseInfo(intent)).not.toThrow();
  });

  it('accepts a name containing a space', () => {
    // Their pattern admits spaces explicitly, so a double-barrelled or middle
    // name is not the failure case below.
    expect(() =>
      assertHyperCardBaseInfo({ ...intent, firstName: 'Mary Ann' }),
    ).not.toThrow();
  });

  it.each([
    ['an apostrophe', "O'Brien"],
    ['a hyphen', 'Jean-Luc'],
    ['an accent', 'Müller'],
    ['a digit', 'Ada2'],
  ])('refuses a name containing %s', (_case, lastName) => {
    // All four pass the shared onboarding DTO, which validates a name only as a
    // string — this issuer's pattern is letters and spaces alone.
    expect(() => assertHyperCardBaseInfo({ ...intent, lastName })).toThrow(
      CardProviderIntentRejectedError,
    );
  });

  it('names the offending field in our vocabulary, not theirs', () => {
    // The message is handed to a partner as-is, so it has to name a field on
    // the request they sent — never `base_info` or `first_name`.
    expect(() =>
      assertHyperCardBaseInfo({ ...intent, firstName: "O'Brien" }),
    ).toThrow(/firstName/);
  });

  it('refuses a name longer than they accept', () => {
    expect(() =>
      assertHyperCardBaseInfo({ ...intent, firstName: 'a'.repeat(51) }),
    ).toThrow(CardProviderIntentRejectedError);
  });

  it('accepts a name exactly at their limit', () => {
    expect(() =>
      assertHyperCardBaseInfo({ ...intent, firstName: 'a'.repeat(50) }),
    ).not.toThrow();
  });

  it.each([
    ['a tagged local part', 'ada+cards@example.com'],
    ['consecutive dots', 'ada..lovelace@example.com'],
    ['a single-letter top-level domain', 'ada@example.c'],
    ['no domain at all', 'ada@example'],
  ])('refuses an address their pattern excludes: %s', (_case, email) => {
    // Their regex is markedly narrower than a general one. The tagged local
    // part is the case worth knowing: it is a perfectly ordinary address that
    // `@IsEmail()` accepts and their endpoint would reject.
    expect(() => assertHyperCardBaseInfo({ ...intent, email })).toThrow(
      CardProviderIntentRejectedError,
    );
  });

  it.each([
    ['a dotted local part', 'ada.lovelace@example.com'],
    ['a hyphenated domain', 'ada@ex-ample.com'],
    ['a subdomain', 'ada@mail.example.com'],
    ['an underscore', 'ada_l@example.com'],
  ])('accepts an address their pattern allows: %s', (_case, email) => {
    expect(() => assertHyperCardBaseInfo({ ...intent, email })).not.toThrow();
  });

  it('refuses an address longer than they accept', () => {
    const local = 'a'.repeat(60);

    expect(() =>
      assertHyperCardBaseInfo({ ...intent, email: `${local}@example.com` }),
    ).toThrow(CardProviderIntentRejectedError);
  });

  it('refuses a pathological address without backtracking', () => {
    // A regression test for a denial of service, not for a validation rule.
    const pathological = `a@${'a'.repeat(58)}.COM`;
    expect(pathological).toHaveLength(64);

    const startedAt = Date.now();
    expect(() =>
      assertHyperCardBaseInfo({ ...intent, email: pathological }),
    ).toThrow(CardProviderIntentRejectedError);

    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it.each([
    ['too short', '12345'],
    ['too long', '123456789012'],
  ])('refuses a mobile number that is %s', (_case, cellNumber) => {
    expect(() =>
      assertHyperCardBaseInfo(withProvenance({ cellNumber })),
    ).toThrow(CardProviderIntentRejectedError);
  });

  it.each([
    ['their minimum', '123456'],
    ['their maximum', '12345678901'],
  ])('accepts a mobile number at %s', (_case, cellNumber) => {
    expect(() =>
      assertHyperCardBaseInfo(withProvenance({ cellNumber })),
    ).not.toThrow();
  });

  it('accepts a four-digit dialling code', () => {
    // Twenty-one rows of their country table are four digits — the Caribbean
    // codes — and the shared DTO refused all of them until it was widened.
    expect(() =>
      assertHyperCardBaseInfo(withProvenance({ callingCode: '1246' })),
    ).not.toThrow();
  });

  it.each([
    ['a leading plus', '+44'],
    ['five digits', '12345'],
    ['a non-digit', '4a'],
  ])('refuses a dialling code with %s', (_case, callingCode) => {
    expect(() =>
      assertHyperCardBaseInfo(withProvenance({ callingCode })),
    ).toThrow(CardProviderIntentRejectedError);
  });

  it('does not refuse fields their application never carries', () => {
    // Date of birth, address, nationality and place of birth are held for our
    // records and never reach base_info, so a value this issuer would have no
    // opinion on must not be refused on its behalf.
    expect(() =>
      assertHyperCardBaseInfo({
        ...intent,
        dateOfBirth: '1815-12-10',
        residentialAddress: {
          addressLine1: "12 O'Connell Street — Flat 3",
          city: 'Dún Laoghaire',
          country: 'IE',
        },
        identityProvenance: {
          ...intent.identityProvenance,
          nationality: 'Côte d’Ivoirian',
          placeOfBirth: 'CIV',
        },
      }),
    ).not.toThrow();
  });

  it('reports the provider it speaks for', () => {
    try {
      assertHyperCardBaseInfo({ ...intent, firstName: 'Ada2' });
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(CardProviderIntentRejectedError);
      expect((error as CardProviderIntentRejectedError).providerKey).toBe(
        CardProviderKey.HYPERCARD,
      );
      expect((error as CardProviderIntentRejectedError).field).toBe(
        'firstName',
      );
    }
  });
});
