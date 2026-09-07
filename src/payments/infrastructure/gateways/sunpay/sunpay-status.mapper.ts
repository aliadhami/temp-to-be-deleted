import { PaymentStatus } from '../../../domain/payment-status.enum';

/**
 * SunPay's Crypto PayIn status vocabularies → our canonical `PaymentStatus`.
 *
 * There are TWO separate vocabularies, and they are not the same set:
 *
 *   Query Order  `order_status`: PENDING | SUCCESS | CANCEL
 *   Webhook      `biz_status`:   SUCCESS | FAIL
 *
 * Documented at docs.sunpay.pro (Crypto → PayIn → Query Order / Webhook
 * Notification). Anything outside these sets maps to ERROR rather than being
 * guessed at — an unrecognised provider status must never be optimistically
 * read as "paid".
 */

/** `order_status` from GET /api/v3-1/Crypto/PayIn/{orderNo}. */
const ORDER_STATUS_MAP: Readonly<Record<string, PaymentStatus>> = {
  PENDING: PaymentStatus.PENDING,
  SUCCESS: PaymentStatus.PAID,
  CANCEL: PaymentStatus.CANCELLED,
};

/** `biz_status` from the inbound webhook. */
const WEBHOOK_STATUS_MAP: Readonly<Record<string, PaymentStatus>> = {
  SUCCESS: PaymentStatus.PAID,
  FAIL: PaymentStatus.FAILED,
};

const normalize = (value: string | undefined | null): string =>
  (value ?? '').trim().toUpperCase();

export const mapSunPayOrderStatus = (
  orderStatus: string | undefined | null,
): PaymentStatus =>
  ORDER_STATUS_MAP[normalize(orderStatus)] ?? PaymentStatus.ERROR;

export const mapSunPayWebhookStatus = (
  bizStatus: string | undefined | null,
): PaymentStatus =>
  WEBHOOK_STATUS_MAP[normalize(bizStatus)] ?? PaymentStatus.ERROR;

/**
 * Crypto lets a customer send the wrong amount, so "SUCCESS" alone is not
 * proof we were paid what we asked for. Compares as decimal STRINGS — the
 * values arrive as JSON numbers, and routing them through a float before
 * comparison is exactly how a 19.999999 underpayment becomes a clean 20.00.
 *
 * Returns true only when the arrived amount is at least the expected amount,
 * so an underpayment can be refused while an overpayment still settles.
 */
export const isSunPayAmountSufficient = (
  expectedAmount: string,
  actualPaymentAmount: string,
): boolean => {
  const expected = toScaledBigInt(expectedAmount);
  const actual = toScaledBigInt(actualPaymentAmount);
  if (expected === null || actual === null) return false;
  return actual >= expected;
};

/**
 * Parses a decimal string into a BigInt scaled to a fixed 18 decimal places —
 * enough for every chain we might see (ETH's wei is 18) and exact, unlike
 * parseFloat. Returns null for anything unparseable.
 */
const SCALE = 18;
const toScaledBigInt = (value: string): bigint | null => {
  const trimmed = (value ?? '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;

  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  if (fraction.length > SCALE) return null; // more precision than we can represent

  const scaled = BigInt(whole + fraction.padEnd(SCALE, '0'));
  return negative ? -scaled : scaled;
};
