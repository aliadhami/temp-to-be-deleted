import { Logger } from '@nestjs/common';
import { CardTransaction } from '../../../domain/card-issuer.port';
import {
  isZeroHyperCardAmount,
  normaliseHyperCardAmount,
  normaliseHyperCardInteger,
  normaliseHyperCardSignedAmount,
  normaliseHyperCardText,
} from './hypercard-coercion.util';
import {
  HyperCardStatement,
  HyperCardTransactionRow,
  HyperCardTransactionStatus as Status,
  HyperCardTransactionType as Type,
} from './hypercard.types';

const logger = new Logger('HyperCardTransactionMapper');

/**
 * A statement row that could not be turned into a transaction. Adapter-local
 * rather than a domain error, matching the balance and card-detail mappers: an
 * unreadable payload is a gap of ours.
 */
export class HyperCardTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HyperCardTransactionError';
  }
}

/**
 * Their "Transaction type" appendix, as the category the port publishes. The
 * port defines no shared vocabulary, so these are this adapter's own labels.
 */
export const HYPERCARD_CATEGORY_BY_TYPE: Readonly<Record<number, string>> = {
  [Type.CONSUME]: 'consume',
  [Type.RECHARGE]: 'recharge',
  [Type.WITHDRAWAL]: 'withdrawal',
  [Type.TRANSFER_IN]: 'transfer_in',
  [Type.TRANSFER_OUT]: 'transfer_out',
  [Type.OTHER]: 'other',
  [Type.SETTLEMENT_ADJUSTMENT]: 'settlement_adjustment',
  [Type.REFUND]: 'refund',
  [Type.PAYMENT_REVERSAL]: 'payment_reversal',
  [Type.FEE]: 'fee',
  [Type.FEE_REVERSAL]: 'fee_reversal',
  [Type.OTC_REFUND]: 'otc_refund',
  [Type.OTC_REFUND_REVERSAL]: 'otc_refund_reversal',
  [Type.CONSUMPTION_FAILURE]: 'consumption_failure',
  [Type.BINDING_CARD_VERIFICATION]: 'binding_card_verification',
  [Type.TRANSACTION_SERVICE_FEE]: 'transaction_service_fee',
  [Type.RESCISSION]: 'rescission',
  [Type.DISPUTE_APPEAL_FAILED]: 'dispute_appeal_failed',
  [Type.DISPUTE_APPEAL_SUCCEEDED]: 'dispute_appeal_succeeded',
  [Type.CREDIT_CARD_BILL_RECONCILIATION]: 'credit_card_bill_reconciliation',
  [Type.PURCHASE_CRYPTO_COIN]: 'purchase_crypto_coin',
  [Type.CANCEL_CARD]: 'cancel_card',
};

/**
 * What a type we do not recognise becomes. The row is kept, the opposite of
 * what the catalogue mapper does with an unrecognised product: a product we
 * cannot model should not be sold, while a transaction we cannot model still
 * happened.
 */
export const HYPERCARD_UNKNOWN_CATEGORY = 'unknown';

/**
 * Their "Transaction Status" appendix, as the status the port publishes. Three
 * values against the five their recharge statuses carry, which is why a
 * deposit's whole lifecycle is not observable from a statement row.
 */
export const HYPERCARD_STATUS_BY_CODE: Readonly<Record<number, string>> = {
  [Status.IN_OPERATION]: 'pending',
  [Status.SUCCESS]: 'settled',
  [Status.FAIL]: 'failed',
};

/**
 * What an absent or unrecognised status becomes. Not success — the expensive
 * direction to guess wrong: a partner told a transaction settled has no reason
 * to look again, while one told it is still in flight does.
 */
const UNKNOWN_STATUS = 'pending';

const readEpochSeconds = (
  raw: string | number | undefined,
  field: string,
): string | null => {
  const seconds = normaliseHyperCardInteger(raw);
  if (seconds === null) {
    if (raw !== undefined && raw !== '') {
      logger.warn(
        `HyperCard sent ${field} "${String(
          raw,
        )}" on a statement row, which is not a Unix timestamp this can read`,
      );
    }
    return null;
  }

  return new Date(seconds * 1000).toISOString();
};

/**
 * Their identifier for the row. A JSON number is used only when stringifying
 * it is provably exact.
 */
const readTransactionId = (raw: unknown): string => {
  if (typeof raw === 'number' && !Number.isSafeInteger(raw)) {
    logger.warn(
      `HyperCard sent tx_id as the JSON number ${raw}, which is past the range a parser preserves exactly — publishing what the parser kept, since a statement row cannot be identified without it`,
    );
    // `BigInt` rather than `String`, which would publish exponential notation
    // (`2.02e+23`) for a value every other row states in digits — unmatchable
    // against anything a partner holds. Guarded because `BigInt` refuses a
    // non-integer, which is a shape their identifiers should never take.
    return Number.isInteger(raw) ? BigInt(raw).toString() : String(raw);
  }

  const id = normaliseHyperCardText(raw);
  if (id === null) {
    throw new HyperCardTransactionError(
      'HyperCard returned a statement row carrying no readable tx_id',
    );
  }

  return id;
};

/**
 * Whether the row added money or took it away, from the pair they publish
 * beside the amount.
 */
const signOf = (
  row: HyperCardTransactionRow,
  magnitude: string,
  publishedNegative: boolean,
): string => {
  const credit = normaliseHyperCardAmount(row.credit);
  const debit = normaliseHyperCardAmount(row.debit);
  const credited = credit !== null && !isZeroHyperCardAmount(credit);
  const debited = debit !== null && !isZeroHyperCardAmount(debit);

  if (debited && !credited) return `-${magnitude}`;
  if (credited && !debited) return magnitude;

  // A zero amount has no direction to get wrong, so only a real figure with an
  // undecidable pair is worth a line.
  if (!isZeroHyperCardAmount(magnitude)) {
    logger.warn(
      `HyperCard published credit "${String(row.credit)}" and debit "${String(
        row.debit,
      )}" on a statement row of ${magnitude}, which does not say which direction the money moved — falling back to the sign on the amount itself`,
    );
  }

  // Their own sign, when the pair decides nothing. Usually there is none and
  // this is the magnitude unchanged; where they do publish one it is the only
  // statement about direction left.
  return publishedNegative ? `-${magnitude}` : magnitude;
};

/**
 * Every row of their statement answer, flattened, with the shape checked here
 * rather than assumed from the transport's type argument. Nothing validates a
 * response body against the type a caller asked for.
 */
export const readHyperCardStatementRows = (
  data: unknown,
): HyperCardTransactionRow[] => {
  if (data === null || data === undefined) return [];

  if (!Array.isArray(data)) {
    throw new HyperCardTransactionError(
      'HyperCard answered a card statement inquiry with a payload that is not a list of statements',
    );
  }

  return (data as HyperCardStatement[]).flatMap((statement) => {
    const rows = statement?.bank_tx_list;
    if (rows === null || rows === undefined) return [];

    if (!Array.isArray(rows)) {
      throw new HyperCardTransactionError(
        `HyperCard answered with a statement for ${String(
          statement?.month_year,
        )} whose transaction list is not a list`,
      );
    }

    return rows;
  });
};

/**
 * When a row happened, before anything else about it is read. Exists so a
 * caller can window before mapping.
 */
export const readHyperCardStatementRowSeconds = (
  row: HyperCardTransactionRow,
): number | null => normaliseHyperCardInteger(row.transaction_date);

/** One row of their card statement, as the port's transaction. */
export const mapHyperCardTransaction = (
  row: HyperCardTransactionRow,
): CardTransaction => {
  const id = readTransactionId(row.tx_id);

  // **Signed, unlike every other amount this folder reads.** The shared
  // coercion refuses a negative, but their appendix carries refund and reversal
  // types, so a signed figure is plausible here and refusing one would take
  // down the whole listing rather than one row.
  const published = normaliseHyperCardSignedAmount(row.tx_amount);
  if (published === null) {
    throw new HyperCardTransactionError(
      `HyperCard returned tx_amount "${String(
        row.tx_amount,
      )}" on statement row ${id}, which is not an amount this can read`,
    );
  }

  const publishedNegative = published.startsWith('-');
  const magnitude = publishedNegative ? published.slice(1) : published;

  const currencyCode = normaliseHyperCardText(row.tx_currency);
  if (currencyCode === null) {
    throw new HyperCardTransactionError(
      `HyperCard returned no readable tx_currency on statement row ${id}`,
    );
  }

  const type = normaliseHyperCardInteger(row.type);
  const category =
    (type === null ? undefined : HYPERCARD_CATEGORY_BY_TYPE[type]) ?? null;
  if (category === null) {
    logger.warn(
      `HyperCard returned transaction type "${String(
        row.type,
      )}" on statement row ${id}, which is not in their transaction-type appendix — keeping the row as "${HYPERCARD_UNKNOWN_CATEGORY}"`,
    );
  }

  const statusCode = normaliseHyperCardInteger(row.status);
  const status =
    (statusCode === null ? undefined : HYPERCARD_STATUS_BY_CODE[statusCode]) ??
    null;
  if (status === null && row.status !== undefined && row.status !== '') {
    logger.warn(
      `HyperCard returned transaction status "${String(
        row.status,
      )}" on statement row ${id}, which is not in their transaction-status appendix — reporting it as "${UNKNOWN_STATUS}"`,
    );
  }

  const createdAt = readEpochSeconds(row.transaction_date, 'transaction_date');
  if (createdAt === null) {
    throw new HyperCardTransactionError(
      `HyperCard returned no readable transaction_date on statement row ${id}`,
    );
  }

  // Their empty fields arrive as `""` rather than as absent keys, which the
  // shared text coercion already reads as nothing — and an absent optional
  // cannot be set to undefined under `exactOptionalPropertyTypes`, so the key
  // is spread in or left off entirely.
  const description = normaliseHyperCardText(row.description);

  return {
    id,
    amount: signOf(row, magnitude, publishedNegative),
    currencyCode: currencyCode.toUpperCase(),
    status: status ?? UNKNOWN_STATUS,
    category: category ?? HYPERCARD_UNKNOWN_CATEGORY,
    ...(description && { description }),
    merchantName: null,
    merchantAmount: null,
    merchantCurrency: null,
    createdAt,
    settledAt: readEpochSeconds(row.posting_date, 'posting_date'),
  };
};
