/**
 * Cuts text to the width of the column holding it.
 *
 * **Code points, never `slice`**: this server runs `STRICT_TRANS_TABLES` and
 * `utf8mb4`, and refuses the lone surrogate a UTF-16 cut can leave behind.
 */
export const truncateToColumn = (value: string, max: number): string => {
  const points = [...value];
  return points.length > max ? points.slice(0, max).join('') : value;
};

/** The same cut for a value an issuer may simply not have sent. */
export const truncatedOrNull = (
  value: string | undefined,
  max: number,
): string | null => (value === undefined ? null : truncateToColumn(value, max));
