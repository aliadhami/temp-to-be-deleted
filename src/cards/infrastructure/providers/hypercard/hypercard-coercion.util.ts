/**
 * Coercions for HyperCard's wire values, shared by every mapper in this
 * folder.
 */

/**
 * One of their integer codes, from either the string or the number form. Null
 * for anything that is not an integer, so an unrecognised code and an
 * unreadable one reach the same branch.
 */
export const normaliseHyperCardInteger = (raw: unknown): number | null => {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) ? raw : null;
  }
  if (typeof raw !== 'string') return null;

  // Guarded before parsing, because Number('') and Number('   ') are both 0 —
  // which would otherwise read an empty string as a real code. Their sandbox
  // does send '' on a field they declare an integer, so this is a live shape.
  const text = raw.trim();
  if (text === '') return null;

  const parsed = Number(text);
  return Number.isInteger(parsed) ? parsed : null;
};

/** A decimal amount, kept as a string. */
const AMOUNT_PATTERN = /^\d+(\.\d+)?$/;

export const normaliseHyperCardAmount = (raw: unknown): string | null => {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? String(raw) : null;
  }
  if (typeof raw !== 'string') return null;

  const text = raw.trim();
  return AMOUNT_PATTERN.test(text) ? text : null;
};

/**
 * An amount, or the caller's own failure. **Never a zero and never a dropped
 * field** — every caller here is reading money.
 */
export const readHyperCardAmount = (
  raw: unknown,
  fail: (raw: unknown) => Error,
): string => {
  const amount = normaliseHyperCardAmount(raw);
  if (amount === null) throw fail(raw);

  return amount;
};

/**
 * The same, but tolerating a leading minus. A separate function rather than a
 * relaxation of the one above, so every existing caller keeps refusing
 * negatives.
 */
const SIGNED_AMOUNT_PATTERN = /^-?\d+(\.\d+)?$/;

export const normaliseHyperCardSignedAmount = (raw: unknown): string | null => {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? String(raw) : null;
  }
  if (typeof raw !== 'string') return null;

  const text = raw.trim();
  return SIGNED_AMOUNT_PATTERN.test(text) ? text : null;
};

/** Zero however many places they published it to: `0`, `0.00`, `0.00000000`. */
const ZERO_AMOUNT_PATTERN = /^0+(\.0+)?$/;

export const isZeroHyperCardAmount = (amount: string): boolean =>
  ZERO_AMOUNT_PATTERN.test(amount);

/**
 * A trimmed, non-empty string from either form, or null. For their identifiers
 * and coin tickers, which arrive as strings today and are not guaranteed to
 * keep doing so.
 */
export const normaliseHyperCardText = (raw: unknown): string | null => {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? String(raw) : null;
  }
  if (typeof raw !== 'string') return null;

  const text = raw.trim();
  return text === '' ? null : text;
};
