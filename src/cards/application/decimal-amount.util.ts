/**
 * Exact arithmetic on the decimal strings this module keeps money in. Every
 * function here works in `BigInt` and none parses a value into a `number`.
 */

/**
 * The scale every comparison is made at — eight decimal places, which is what a
 * crypto-funded card program publishes and the widest either side can carry.
 */
const COMPARISON_SCALE = 8;

/**
 * A non-negative decimal string as an integer at `COMPARISON_SCALE` places.
 * Null past that scale — rounding here would silently move money.
 */
const scale = (value: string): bigint | null => {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;

  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > COMPARISON_SCALE) return null;

  return BigInt(whole + fraction.padEnd(COMPARISON_SCALE, '0'));
};

/** The inverse of `scale`, trailing zeros trimmed. */
const unscale = (scaled: bigint): string => {
  const digits = scaled.toString().padStart(COMPARISON_SCALE + 1, '0');
  const whole = digits.slice(0, digits.length - COMPARISON_SCALE);
  const fraction = digits
    .slice(digits.length - COMPARISON_SCALE)
    .replace(/0+$/, '');

  return fraction === '' ? whole : `${whole}.${fraction}`;
};

/**
 * Compares two decimal strings exactly. Scaled to a fixed number of places and
 * compared as `BigInt`s, never parsed into a `number` — a limit check that
 * admitted an amount a hundredth below a minimum would be doing so with a
 * partner's money.
 */
export const compareDecimalStrings = (
  left: string,
  right: string,
): number | null => {
  const a = scale(left);
  const b = scale(right);
  if (a === null || b === null) return null;

  return a === b ? 0 : a < b ? -1 : 1;
};

/**
 * Adds two decimal strings exactly, or null past the scale. **The currencies
 * are the caller's to check** — nothing here knows what either is denominated
 * in.
 */
export const addDecimalStrings = (
  left: string,
  right: string,
): string | null => {
  const a = scale(left);
  const b = scale(right);
  if (a === null || b === null) return null;

  return unscale(a + b);
};

/**
 * Rounds a decimal string **up** to `decimals` places — up rather than to
 * nearest, these being amounts something must cover. Null past the scale.
 */
export const roundUpDecimalString = (
  value: string,
  decimals: number,
): string | null => {
  const scaled = scale(value);
  if (scaled === null) return null;
  if (!Number.isInteger(decimals) || decimals < 0) return null;
  if (decimals >= COMPARISON_SCALE) return unscale(scaled);

  const step = 10n ** BigInt(COMPARISON_SCALE - decimals);
  const remainder = scaled % step;

  return unscale(remainder === 0n ? scaled : scaled + (step - remainder));
};
