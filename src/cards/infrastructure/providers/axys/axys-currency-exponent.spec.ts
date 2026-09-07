import {
  axysCurrencyExponent,
  axysMinorToDecimal,
} from './axys-currency-exponent';

describe('axysCurrencyExponent', () => {
  it('returns ISO 4217 exponents for the currencies that are not two', () => {
    expect(axysCurrencyExponent('JPY')).toBe(0);
    expect(axysCurrencyExponent('KRW')).toBe(0);
    expect(axysCurrencyExponent('BHD')).toBe(3);
    expect(axysCurrencyExponent('KWD')).toBe(3);
    expect(axysCurrencyExponent('CLF')).toBe(4);
  });

  it('defaults to two for anything the table does not list', () => {
    expect(axysCurrencyExponent('USD')).toBe(2);
    expect(axysCurrencyExponent('EUR')).toBe(2);
    // Not a currency at all. The default is ISO 4217's own, so an unlisted code
    // is a currency with two places rather than one this failed to find.
    expect(axysCurrencyExponent('ZZZ')).toBe(2);
  });

  it('normalises case and surrounding space', () => {
    expect(axysCurrencyExponent('jpy')).toBe(0);
    expect(axysCurrencyExponent(' Bhd ')).toBe(3);
  });
});

describe('axysMinorToDecimal', () => {
  it('shifts by the currency exponent', () => {
    expect(axysMinorToDecimal('1499', 'USD')).toBe('14.99');
    expect(axysMinorToDecimal('1499', 'BHD')).toBe('1.499');
  });

  it('leaves a zero-exponent currency untouched rather than adding a point', () => {
    expect(axysMinorToDecimal('1499', 'JPY')).toBe('1499');
    expect(axysMinorToDecimal('0', 'KRW')).toBe('0');
  });

  it('pads a value shorter than the exponent', () => {
    expect(axysMinorToDecimal('5', 'USD')).toBe('0.05');
    expect(axysMinorToDecimal('5', 'BHD')).toBe('0.005');
    expect(axysMinorToDecimal('0', 'USD')).toBe('0.00');
  });

  it('keeps the sign, which a refund or a reversal carries', () => {
    expect(axysMinorToDecimal('-1499', 'USD')).toBe('-14.99');
    expect(axysMinorToDecimal('-5', 'USD')).toBe('-0.05');
    expect(axysMinorToDecimal('-1499', 'JPY')).toBe('-1499');
  });

  it('strips leading zeros from the whole part but keeps a zero whole part', () => {
    expect(axysMinorToDecimal('001499', 'USD')).toBe('14.99');
    expect(axysMinorToDecimal('099', 'USD')).toBe('0.99');
  });

  it('converts a figure large enough to lose precision as a JS number', () => {
    // Past Number.MAX_SAFE_INTEGER. A division would round this; a digit shift
    // cannot, which is the whole reason the conversion is string arithmetic.
    expect(axysMinorToDecimal('123456789012345678', 'USD')).toBe(
      '1234567890123456.78',
    );
  });

  it('returns null for anything that is not an integer string', () => {
    expect(axysMinorToDecimal('14.99', 'USD')).toBeNull();
    expect(axysMinorToDecimal('', 'USD')).toBeNull();
    expect(axysMinorToDecimal('abc', 'USD')).toBeNull();
    expect(axysMinorToDecimal('1,499', 'USD')).toBeNull();
  });
});
