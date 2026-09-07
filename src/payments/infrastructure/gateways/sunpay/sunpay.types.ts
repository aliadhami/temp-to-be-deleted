/**
 * SunPay Crypto PayIn wire formats. Field names are SunPay's, verbatim —
 * snake_case, and deliberately not renamed, so this file can be diffed against
 * their docs. Nothing outside this folder should import these types.
 *
 * Endpoints:
 *   POST /api/v3-1/Crypto/PayIn            — create order
 *   GET  /api/v3-1/Crypto/PayIn/{orderNo}  — query order (platform order_no)
 */

/** Every SunPay REST response arrives inside this envelope, success or error. */
export interface SunPayEnvelope<T> {
  is_success: boolean;
  code: number;
  msg: string | null;
  data?: T;
  /** Response signature — same HMAC scheme as requests. */
  sign?: string;
  timestamp?: string;
  nonce?: string;
}

export interface SunPayCryptoPayInRequest {
  /** Our reference. Max 64 chars, letters/digits/underscore ONLY — must be unique. */
  out_order_no: string;
  /** Merchant-side user id, max 64 chars. */
  out_user_id: string;
  /** Major units as a decimal number (e.g. 20 = 20 USDT) — NOT minor units. */
  amount: number;
  /** e.g. "TRON" — required. */
  chain_type: string;
  /** e.g. "USDT" — required. */
  currency: string;
  webhook_url?: string;
  redirect_url?: string;
  cancel_url?: string;
}

export interface SunPayCryptoPayInCreateData {
  /** Platform order number — the id required by the query endpoint. Persist it. */
  order_no: string;
  out_order_no: string;
  /** Hosted checkout page the customer is sent to. */
  payment_url: string;
  amount: number;
  currency: string;
  /**
   * Deposit address the customer must send funds to.
   * NOTE: the query endpoint calls this same value `to_address`.
   */
  address: string;
  chain_type: string;
  /** Seconds until the order expires. */
  expires_in: number;
}

/** One on-chain transfer credited to the order. Crypto allows several per order. */
export interface SunPayDepositDetail {
  amount: number;
  txid: string;
  from_address: string;
}

export interface SunPayCryptoPayInQueryData {
  order_no: string;
  out_order_no: string;
  out_user_id: string;
  /** What we asked for. */
  amount: number;
  order_status: string;
  currency: string;
  chain_type: string;
  /** What actually arrived on-chain — may differ from `amount`. */
  actual_payment_amount: number;
  payment_url: string;
  /** Same concept as `address` on the create response — different key. */
  to_address: string;
  expires_in: number;
  fee?: number;
  fee_currency?: string;
  deposit_details?: SunPayDepositDetail[];
}

/**
 * Inbound webhook body. Note there is NO envelope here and no `sign` field —
 * the signature travels in the `SunPay-Sign` header, verified over the raw body.
 */
export interface SunPayWebhookPayload {
  /** `SUCCESS` | `FAIL` */
  biz_status: string;
  /** `PAYIN` for crypto pay-in. */
  biz_type: string;
  data: {
    amount: number;
    actual_payment_amount: number;
    /** Composite on the webhook, e.g. "TRC20_USDT" — not the plain "USDT" we sent. */
    currency: string;
    order_no: string;
    out_order_no: string;
    out_user_id: string;
  };
}

/** Ack body SunPay requires, or it retries the webhook. */
export const SUNPAY_WEBHOOK_ACK = {
  is_success: 'true',
  message: 'success',
} as const;
