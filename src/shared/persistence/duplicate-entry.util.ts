import { QueryFailedError } from 'typeorm';

/** MariaDB's error code for a unique-constraint violation. */
const DUPLICATE_ENTRY_CODE = 'ER_DUP_ENTRY';

/**
 * The failures where the server's own advice is to run the transaction again.
 * `ER_CHECKREAD` is "Record has changed since last read" — a row this
 * transaction read was committed by another before it got to write.
 */
const RESTART_TRANSACTION_CODES = new Set(['ER_CHECKREAD', 'ER_LOCK_DEADLOCK']);

/**
 * Pulls the index name out of a duplicate-entry message. MariaDB writes
 * `Duplicate entry 'x' for key 'index_name'`; MySQL 8 qualifies the same field
 * with the table.
 */
const DUPLICATE_KEY_PATTERN = /for key '(?:[^'.]*\.)?([^']+)'/;

/** Whether a write failed because it violated a unique constraint. */
export const isDuplicateEntryError = (
  error: unknown,
  indexName?: string,
): boolean => {
  if (!(error instanceof QueryFailedError)) return false;

  const driverError = error as unknown as {
    code?: string;
    sqlMessage?: string;
  };
  if (driverError.code !== DUPLICATE_ENTRY_CODE) return false;
  if (indexName === undefined) return true;

  const message = driverError.sqlMessage ?? error.message;
  return DUPLICATE_KEY_PATTERN.exec(message)?.[1] === indexName;
};

/**
 * Whether a write failed for a reason the server expects the caller to resolve
 * by running the whole transaction again. Safe to act on only when the
 * transaction can be repeated without changing its meaning.
 */
export const isTransactionRestartError = (error: unknown): boolean => {
  if (!(error instanceof QueryFailedError)) return false;

  const { code } = error as unknown as { code?: string };
  return code !== undefined && RESTART_TRANSACTION_CODES.has(code);
};
