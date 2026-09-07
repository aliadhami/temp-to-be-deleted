import {
  buildHyperCardTradeNumber,
  HYPERCARD_TRADE_NUMBER_MAX_LENGTH,
  HyperCardTradeNumberError,
  parseHyperCardTradeNumber,
} from './hypercard-trade-number.util';

describe('buildHyperCardTradeNumber', () => {
  // A UUID of the shape the cardholder table's insert hook writes.
  const publicId = '9f8c1e2a-4b7d-4c3e-8a51-6d2f0b9e7c14';

  it('derives the transaction number by stripping the dashes', () => {
    expect(buildHyperCardTradeNumber(publicId)).toBe(
      '9f8c1e2a4b7d4c3e8a516d2f0b9e7c14',
    );
  });

  it('returns the same number for the same cardholder every time', () => {
    // The onboarding route carries no idempotency key, so nothing outside this
    // function makes the value stable. A cardholder handed two different
    // transaction numbers would be two applications to HyperCard and one row
    // here, with no way to tell which outcome belongs to it.
    expect(buildHyperCardTradeNumber(publicId)).toBe(
      buildHyperCardTradeNumber(publicId),
    );
  });

  it('gives different cardholders different numbers', () => {
    expect(buildHyperCardTradeNumber(publicId)).not.toBe(
      buildHyperCardTradeNumber('0d4a7b61-2c93-4f18-9e05-3a8b6c1d2e7f'),
    );
  });

  it('reverses back to the public id it was derived from', () => {
    // Deliberate: this is the value HyperCard's support holds when asking about
    // an application or a deposit, and it has to lead back to a row here.
    const tradeNumber = buildHyperCardTradeNumber(publicId);
    const restored = [
      tradeNumber.slice(0, 8),
      tradeNumber.slice(8, 12),
      tradeNumber.slice(12, 16),
      tradeNumber.slice(16, 20),
      tradeNumber.slice(20),
    ].join('-');

    expect(restored).toBe(publicId);
  });

  it('lower-cases an upper-case public id', () => {
    expect(buildHyperCardTradeNumber(publicId.toUpperCase())).toBe(
      buildHyperCardTradeNumber(publicId),
    );
  });

  it('stays inside their documented length cap', () => {
    // Their "Application (Express)-v4" page caps the field at 64 characters and
    // states no character set at all, so the output is also checked against the
    // alphabet their own examples use rather than against a guess at a wider one.
    const tradeNumber = buildHyperCardTradeNumber(publicId);

    expect(tradeNumber).toHaveLength(32);
    expect(tradeNumber.length).toBeLessThanOrEqual(
      HYPERCARD_TRADE_NUMBER_MAX_LENGTH,
    );
    expect(tradeNumber).toMatch(/^[0-9a-f]+$/);
  });

  it.each([
    ['an empty public id', ''],
    ['separators alone', '----'],
    ['whitespace', '   '],
    [
      'a UUID with its dashes already stripped',
      '9f8c1e2a4b7d4c3e8a516d2f0b9e7c14',
    ],
    [
      'a UUID with dashes in the wrong places',
      '9f8c1e2a4-b7d-4c3e-8a51-6d2f0b9e7c14',
    ],
    ['a non-hex character', '9f8c1e2g-4b7d-4c3e-8a51-6d2f0b9e7c14'],
    ['a truncated UUID', '9f8c1e2a-4b7d-4c3e-8a51-6d2f0b9e7c1'],
    ['some other identifier entirely', 'cardholder-42'],
  ])('refuses %s', (_case, input) => {
    // The input shape is required, not normalised, and that is load-bearing:
    // stripping every non-hex character from an arbitrary string is not
    // injective, so accepting one would quietly break the argument that no
    // unique constraint is needed on the column this value lands in.
    expect(() => buildHyperCardTradeNumber(input)).toThrow(
      HyperCardTradeNumberError,
    );
  });

  it('refuses two inputs that would otherwise collide', () => {
    // The concrete collision the shape check exists to prevent: both of these
    // strip to the same 32 characters, and one transaction number shared by two
    // cardholders means one application result read as the other's.
    expect(() => buildHyperCardTradeNumber('ab-c')).toThrow(
      HyperCardTradeNumberError,
    );
    expect(() => buildHyperCardTradeNumber('abc')).toThrow(
      HyperCardTradeNumberError,
    );
  });
});

describe('parseHyperCardTradeNumber', () => {
  const publicId = '9f8c1e2a-4b7d-4c3e-8a51-6d2f0b9e7c14';

  it('round-trips every derivation back to the public id it came from', () => {
    // The pair is what makes a callback's reference reach the row that asked
    // for the thing it reports on. Either half alone proves nothing.
    for (const id of [
      publicId,
      '0d4a7b61-2c93-4f18-9e05-3a8b6c1d2e7f',
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
    ]) {
      expect(parseHyperCardTradeNumber(buildHyperCardTradeNumber(id))).toBe(id);
    }
  });

  it('lower-cases an upper-case wire value', () => {
    expect(parseHyperCardTradeNumber('9F8C1E2A4B7D4C3E8A516D2F0B9E7C14')).toBe(
      publicId,
    );
  });

  it.each([
    ['an empty value', ''],
    ['whitespace', '   '],
    ['a canonical UUID, dashes and all', publicId],
    ['a value one character short', '9f8c1e2a4b7d4c3e8a516d2f0b9e7c1'],
    ['a value one character long', '9f8c1e2a4b7d4c3e8a516d2f0b9e7c145'],
    ['a non-hex character', '9f8c1e2g4b7d4c3e8a516d2f0b9e7c14'],
    ['some other identifier entirely', '00003454323400000028888'],
  ])('refuses %s', (_case, input) => {
    // Null rather than a reshaped guess: this account has one callback
    // address, so a reference that was never ours is ordinary traffic, and
    // forcing it into a UUID would aim a lookup at another environment's rows.
    expect(parseHyperCardTradeNumber(input)).toBeNull();
  });
});
