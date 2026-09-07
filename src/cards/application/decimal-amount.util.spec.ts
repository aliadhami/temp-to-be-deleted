import {
  addDecimalStrings,
  compareDecimalStrings,
  roundUpDecimalString,
} from './decimal-amount.util';

describe('compareDecimalStrings', () => {
  it('orders amounts by value rather than by text', () => {
    expect(compareDecimalStrings('9', '10')).toBeLessThan(0);
    expect(compareDecimalStrings('100', '20')).toBeGreaterThan(0);
    // '9' sorts after '10' as text, which is the whole reason this exists.
    expect(compareDecimalStrings('9', '100000')).toBeLessThan(0);
  });

  it('treats differently written forms of one amount as equal', () => {
    expect(compareDecimalStrings('10', '10.00')).toBe(0);
    expect(compareDecimalStrings('10.00000000', '10')).toBe(0);
    expect(compareDecimalStrings(' 10 ', '10')).toBe(0);
  });

  it('compares exactly at a boundary a float would misjudge', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754; these are the same value.
    expect(compareDecimalStrings('0.3', '0.30000000')).toBe(0);
    expect(compareDecimalStrings('10.00000001', '10')).toBeGreaterThan(0);
    expect(compareDecimalStrings('9.99999999', '10')).toBeLessThan(0);
  });

  it('refuses a value beyond the comparison scale rather than truncating it', () => {
    // Truncation rounds down, so this would otherwise compare equal to 10 and
    // admit an amount below the limit being enforced.
    expect(compareDecimalStrings('10', '10.000000001')).toBeNull();
  });

  it('refuses anything that is not a plain decimal', () => {
    expect(compareDecimalStrings('ten', '10')).toBeNull();
    expect(compareDecimalStrings('10', '')).toBeNull();
    expect(compareDecimalStrings('-10', '10')).toBeNull();
    expect(compareDecimalStrings('1e3', '10')).toBeNull();
  });
});

describe('addDecimalStrings', () => {
  it('adds exactly where a float would not', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in IEEE-754.
    expect(addDecimalStrings('0.1', '0.2')).toBe('0.3');
    expect(addDecimalStrings('102.71614508', '20')).toBe('122.71614508');
    expect(addDecimalStrings('188.88', '0.88')).toBe('189.76');
  });

  it('trims to the amount rather than to the scale it was added at', () => {
    expect(addDecimalStrings('10', '20')).toBe('30');
    expect(addDecimalStrings('10.50', '0.50')).toBe('11');
  });

  it('carries across the whole/fraction boundary', () => {
    expect(addDecimalStrings('0.99999999', '0.00000001')).toBe('1');
  });

  it('handles amounts far past what a float carries faithfully', () => {
    expect(addDecimalStrings('99999999999999999999', '1')).toBe(
      '100000000000000000000',
    );
  });

  it('refuses a value beyond the scale rather than rounding one', () => {
    expect(addDecimalStrings('1', '0.000000001')).toBeNull();
  });

  it.each([
    ['', '1'],
    ['-1', '1'],
    ['abc', '1'],
    ['1', '1e3'],
  ])('refuses %s + %s, which is not a plain decimal', (left, right) => {
    expect(addDecimalStrings(left, right)).toBeNull();
  });
});

describe('roundUpDecimalString', () => {
  it('rounds up rather than to nearest', () => {
    expect(roundUpDecimalString('102.71614508', 6)).toBe('102.716146');
    expect(roundUpDecimalString('102.71614501', 6)).toBe('102.716146');
    expect(roundUpDecimalString('1.000000001', 6)).toBeNull();
  });

  it('leaves an amount that already fits alone', () => {
    expect(roundUpDecimalString('102.716145', 6)).toBe('102.716145');
    expect(roundUpDecimalString('100', 6)).toBe('100');
    expect(roundUpDecimalString('10.50', 6)).toBe('10.5');
  });

  it('carries into the whole part', () => {
    expect(roundUpDecimalString('0.9999999', 6)).toBe('1');
    expect(roundUpDecimalString('9.99999999', 0)).toBe('10');
  });

  it('leaves a value alone at or beyond the scale it is held to', () => {
    expect(roundUpDecimalString('102.71614508', 8)).toBe('102.71614508');
    expect(roundUpDecimalString('102.71614508', 18)).toBe('102.71614508');
  });

  it('refuses an unreadable amount or a nonsensical precision', () => {
    expect(roundUpDecimalString('abc', 6)).toBeNull();
    expect(roundUpDecimalString('1', -1)).toBeNull();
    expect(roundUpDecimalString('1', 1.5)).toBeNull();
  });
});
