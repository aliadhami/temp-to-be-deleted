/**
 * Turns Axys's minor-unit amounts into the decimal strings the port publishes.
 */

/**
 * Every currency whose minor-unit exponent is not two, from ISO 4217. The
 * table lists only the exceptions, and that is what makes the fallback correct
 * rather than hopeful.
 */
const EXPONENT_BY_CURRENCY: Readonly<Record<string, number>> = {
  // No minor unit at all.
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // Three places.
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  // Four.
  CLF: 4,
  UYW: 4,
};

/** ISO 4217's own default, which is why the table above holds only exceptions. */
const DEFAULT_EXPONENT = 2;

export const axysCurrencyExponent = (currencyCode: string): number =>
  EXPONENT_BY_CURRENCY[currencyCode.trim().toUpperCase()] ?? DEFAULT_EXPONENT;

/** An optionally signed run of digits, which is all a minor-unit amount can be. */
const MINOR_AMOUNT_PATTERN = /^-?\d+$/;

/**
 * A minor-unit amount as a decimal string in the currency's own units. String
 * arithmetic throughout, never a division.
 */
export const axysMinorToDecimal = (
  amountMinor: string,
  currencyCode: string,
): string | null => {
  const raw = amountMinor.trim();
  if (!MINOR_AMOUNT_PATTERN.test(raw)) return null;

  const negative = raw.startsWith('-');
  const digits = negative ? raw.slice(1) : raw;

  const exponent = axysCurrencyExponent(currencyCode);
  if (exponent === 0) return negative ? `-${digits}` : digits;

  // Left-padded so a value shorter than the exponent still has a whole part:
  // five minor units of a three-place currency is `0.005`, and without the
  // padding the split below would produce an empty integer part.
  const padded = digits.padStart(exponent + 1, '0');
  const whole = padded.slice(0, padded.length - exponent);
  const fraction = padded.slice(padded.length - exponent);

  // Leading zeros on the whole part are stripped — `0012.34` is not a shape any
  // other money value in this codebase takes — but a zero whole part is kept.
  const normalisedWhole = whole.replace(/^0+(?=\d)/, '');

  return `${negative ? '-' : ''}${normalisedWhole}.${fraction}`;
};
