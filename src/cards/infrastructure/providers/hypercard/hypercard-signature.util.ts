/** The header carrying the signature itself — never part of the signed string. */
export const HYPERCARD_SIGNATURE_FIELD = 'signature';

/**
 * The only headers that take part in the signature. An inbound request carries
 * many more (content-type, host, user-agent); none were signed by HyperCard,
 * so they must never reach the canonical string.
 */
export const HYPERCARD_SIGNED_HEADER_NAMES = [
  'timestamp',
  'nonce',
  'api-key',
  'version',
  'lang',
] as const;

const SIGNED_HEADER_SET = new Set<string>(HYPERCARD_SIGNED_HEADER_NAMES);

/**
 * Narrows an arbitrary header bag to the signed subset, lower-casing names on
 * the way (HTTP header names are case-insensitive, and Node lower-cases
 * inbound ones already — this makes the behaviour explicit rather than
 * incidental).
 */
export const pickSignedHeaders = (
  headers: Record<string, unknown>,
): Record<string, unknown> => {
  const picked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (SIGNED_HEADER_SET.has(name)) picked[name] = value;
  }
  return picked;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isContainer = (value: unknown): boolean =>
  Array.isArray(value) || isPlainObject(value);

/**
 * Renders a scalar as HyperCard's verifier expects it: booleans capitalised as
 * `True` and `False`, and null spelled `None`.
 */
const scalarToCanonical = (value: unknown): string => {
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  // A JSON body holds nothing else, and containers are handled separately.
  // Anything exotic (a symbol, a function) is out of contract: represent it as
  // empty so the field is dropped rather than signing a meaningless token.
  return '';
};

/** Renders a value nested inside a container. */
const nestedToCanonical = (value: unknown): string => {
  if (typeof value === 'string') {
    return value.includes("'") ? `"${value}"` : `'${value}'`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(nestedToCanonical).join(', ')}]`;
  }
  if (isPlainObject(value)) {
    const inner = Object.entries(value)
      .map(
        ([key, item]) =>
          `${nestedToCanonical(key)}: ${nestedToCanonical(item)}`,
      )
      .join(', ');
    return `{${inner}}`;
  }
  return scalarToCanonical(value);
};

/**
 * The value half of one `name=value` pair, with three replacements applied to
 * the whole serialised string:
 *
 *     '  ->  "          ", "  ->  ","          ": "  ->  ":"
 *
 * **These rewrite string *content* as well as structure** — an address of
 * `x, y` signs as `x,y`. Lossy and almost certainly unintended, but their
 * verifier computes the same thing, so reproducing it is mandatory.
 */
const canonicalValue = (value: unknown): string =>
  (isContainer(value) ? nestedToCanonical(value) : scalarToCanonical(value))
    .replace(/'/g, '"')
    .replace(/, /g, ',')
    .replace(/: /g, ':');

/**
 * Decides whether a field participates at all. Concatenates every scalar
 * reachable from the value; the field is dropped when the result is empty.
 *
 * The consequences do not follow obviously: `0` and `false` are KEPT, rendering
 * as `0` and `False`, while `{}`, `[]`, `{"a": ""}` and `[""]` are all DROPPED.
 */
const reachableScalars = (value: unknown): string => {
  if (Array.isArray(value)) {
    return value.map(reachableScalars).join('');
  }
  if (isPlainObject(value)) {
    return Object.values(value).map(reachableScalars).join('');
  }
  if (value === null || value === undefined) return '';
  return scalarToCanonical(value);
};

/**
 * Builds the string HyperCard signs and verifies:
 *
 *  1. merge the signed headers with the request body into one map,
 *  2. drop the `signature` field and any field with an empty value,
 *  3. sort by field name, ascending,
 *  4. join as `name=value` pairs separated by `&`.
 *
 * A body field **wins** a name collision against a header of the same name.
 * The formatting follows their official demo and is locked by golden-vector
 * tests. Pass only signed headers: use `pickSignedHeaders` on anything off the
 * wire.
 */
export const buildHyperCardCanonicalString = (
  headers: Record<string, unknown>,
  body: Record<string, unknown>,
): string => {
  const merged: Record<string, unknown> = { ...headers, ...body };

  return (
    Object.keys(merged)
      .filter((key) => key !== HYPERCARD_SIGNATURE_FIELD)
      .filter((key) => reachableScalars(merged[key]) !== '')
      // Plain `<`/`>` compares UTF-16 code units, which is the ordering the
      // verifier uses. localeCompare would be wrong — it is locale-sensitive.
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => `${key}=${canonicalValue(merged[key])}`)
      .join('&')
  );
};
