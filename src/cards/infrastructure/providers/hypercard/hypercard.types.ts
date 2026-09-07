/**
 * HyperCard's raw wire shapes. Private to this folder — nothing outside
 * `providers/hypercard/` imports from here.
 */

/** The success code on every response, per their "API Specification" page. Any other value is an error. */
export const HYPERCARD_SUCCESS_CODE = '00000';

/**
 * Their "Parameter error" code. Generic across their API — a malformed email,
 * a missing field and an unsupported product identifier all answer it.
 */
export const HYPERCARD_PARAMETER_ERROR_CODE = 'A0003';

/**
 * Their "Client error" code — the most generic they publish, and what their
 * operation endpoints answer both for a reference they do not hold and for a
 * request colliding with one in flight, discriminated only by free text.
 *
 * **It must never join the conflict set**, which every endpoint's response
 * handling consults: that would turn every generic client error into a 409.
 */
export const HYPERCARD_CLIENT_ERROR_CODE = 'A0000';

/** Their "Card no existed" code. Only unambiguous where the request carries a card id. */
export const HYPERCARD_CARD_NOT_HELD_CODE = 'A0004';

/**
 * The envelope wrapping every response: `code` is a string (`"00000"` on
 * success), `msg` the human-readable reason, `data` the payload.
 */
export interface HyperCardEnvelope<T> {
  code: string;
  msg: string;
  data?: T;
}

/**
 * One coin's row from their "Merchant Balance" endpoint. Amounts are strings —
 * their spec requires it "to avoid loss of precision", which matches this
 * codebase's own money rule. Typed as their wire really behaves rather than as
 * their table declares it: their empty value is `""` and their numbers arrive
 * quoted or not.
 */
export interface HyperCardMerchantBalanceEntry {
  /** Available balance for this coin. */
  amount?: string | number;
  coin?: string | number;
  /** Total balance for this coin, including any amount not yet available. */
  total_amount?: string | number;
}

/**
 * One product row from their "Card config list" endpoint. Every field is
 * optional and multi-typed, and neither is defensiveness.
 */
export interface HyperCardCardProductRow {
  /** Their stable handle for the product — our `providerProductId`. */
  card_type_id?: string | number;
  /** Their "Bank card type" appendix: virtual or physical. */
  card_type?: string | number;
  /** Their "Card Organization" appendix: the network. */
  card_org?: string | number;
  /** Their "Card material" appendix. Absent when they publish none. */
  card_sub_type?: string | number;
  /** Their "Application Type" appendix. */
  apply_type?: string | number;
  /** Their "Method of Activation" appendix. */
  activate_type?: string | number;
  /** The coin the card itself is denominated in, lowercase on their wire. */
  card_coin?: string | number;
  /** One-off card-opening fee. Their page: "in usdt". */
  card_fee?: string | number;
  /** Recurring fee. Their page: "in usdt". */
  annual_fee?: string | number;
  /** A fraction, not a percentage — their page: "if this value is 0.02, it means 2%". */
  recharge_fee?: string | number;
  min_single_recharge_amount?: string | number;
  max_single_recharge_amount?: string | number;
  /** Their page: the maximum in one day. */
  max_recharge_amount?: string | number;
  /** 1 mandatory, 0 not. */
  need_first_recharge?: string | number;
  min_first_recharge_amount?: string | number;
  /**
   * 1 supported, 0 not. Not merely a funding flag: when recharge is
   * unsupported, card opening is not allowed either.
   */
  can_recharge?: string | number;
  /** Their page: "1: enabled; 0: disabled. Disabled cards cannot apply for card issuance". */
  status?: string | number;
  /**
   * Which operations this product accepts — a comma-separated list of the
   * codes in their "Operation Type" appendix. Absent is not "all of them".
   */
  support_business?: string | number;
  /**
   * Their "Ways to obtain bank card details" setting. Added to this response
   * after it shipped, so an absent value predates the field rather than
   * declining it.
   */
  card_detail_obtain_way?: string | number;
}

/**
 * Their "Operation Type" appendix, which is the table `support_business`
 * points at. There is no code 7 or 8 — the gap is theirs.
 *
 * Their operation-result page renders the same list with five entries and
 * different words for the first two ("Lock"/"Unlock" against the appendix's
 * "Freeze"/"Unfreeze"), and their operation-request page enumerates none —
 * which is why our own vocabulary is what the catalogue publishes.
 */
export const HyperCardOperationType = {
  FREEZE: 1,
  UNFREEZE: 2,
  REPORT_LOSS: 3,
  RESET_PASSWORD: 4,
  CARD_REISSUE: 5,
  RESEND_OR_RESET_PIN: 6,
  CANCEL_CARD: 9,
} as const;

/**
 * Their "Card Operation result" statuses — another integer vocabulary sharing
 * `1` with the others and meaning something else. Unlike their recharge
 * appendix, this list carries no "is final status" column.
 */
export const HyperCardOperationStatus = {
  IN_OPERATION: 0,
  THIRD_PARTY_SUCCESS: 1,
  FAIL: 2,
  /** Awaiting payment. A freeze should cost nothing. */
  PENDING_PAYMENT: 98,
  WAITING_FOR_THIRD_PARTY: 99,
} as const;

/** The `data` payload of their "Card Operation result" endpoint. */
export interface HyperCardOperationResultData {
  /** Their card id, echoed back. */
  card_id?: string | number;
  /** The reference the request was submitted under, echoed back. */
  request_number?: string | number;
  /**
   * See `HyperCardOperationStatus`. An integer here and a string on their push
   * event, for the same five values.
   */
  operate_status?: string | number;
  /** Their card replacement's. Present and empty on everything else. */
  express_company?: string | number;
  express_no?: string | number;
}

/**
 * Their `data` payload from the "Bank card detail-v2" endpoint. Optional and
 * multi-typed for the reason the product row is.
 */
export interface HyperCardCardDetailData {
  /** Our own public key, echoed back. Compared against what was sent. */
  pub_key?: string;
  /** Their card id, echoed back. */
  card_id?: string | number;
  /** RSA-encrypted under `pub_key`, then base64. */
  encoded_card_detail?: string;
  /** See `HyperCardCardDetailObtainWay`. */
  card_detail_obtain_way?: string | number;
  /** Their "Bank card type" appendix: 1 virtual, 2 physical. */
  card_type?: string | number;
}

/**
 * The decrypted plaintext, whose fields depend on the obtain way and the card
 * type — their four published combinations as one flat union. The mapper
 * decides which fields are meaningful before reading any of them.
 */
export interface HyperCardCardDetailPlaintext {
  /** The **full** PAN, not a masked one. */
  card_number?: string | number;
  cvv?: string | number;
  /** `MM/YYYY`, e.g. `04/2025`. */
  expire?: string | number;
  /** Hosted-page obtain way only. */
  url?: string | number;
  password?: string | number;
  /** Unix seconds. Their page types it `long`; their example quotes it. */
  expires_at?: string | number;
  /** Seconds. Their page types it `integer`; their example quotes it. */
  expires_in?: string | number;
}

/**
 * Their "Ways to obtain bank card details" vocabulary. A fourth value is
 * refused rather than guessed: each selects a different plaintext shape, so an
 * unfamiliar one means we do not know what the bytes we just decrypted are.
 */
export const HyperCardCardDetailObtainWay = {
  /** Returned by the detail endpoint. */
  API: 0,
  /** A URL the cardholder opens, optionally behind a password. */
  HOSTED_PAGE: 1,
  /** The issuer emails the secrets to the cardholder; only a number comes back. */
  EMAIL: 2,
} as const;

/**
 * The `data` payload of their "Balance Inquiry" endpoint. Five fields and no
 * timestamp, so there is nothing here to fill an observation time from — the
 * caller supplies its own read time.
 */
export interface HyperCardCardBalanceData {
  /** Spendable now. Their example publishes `"100.00"`. */
  available_balance?: string | number;
  /** The ledger figure, which their example publishes larger than the available one. */
  current_balance?: string | number;
  /** The card's own fiat currency, lowercase on the wire (`"usd"`). */
  card_currency?: string | number;
  /** A masked number. Deliberately not mapped — see the adapter. */
  card_number?: string | number;
  /** Their example sends `"N/A"` and their sandbox sends `""`. Not mapped. */
  card_type?: string | number;
}

/**
 * The `result` object from their "Application Result-v2" endpoint — the
 * outcome of one card application, looked up by the transaction number sent
 * with it.
 */
export interface HyperCardApplicationResultRow {
  /** Their card id, and the handle every later call is keyed on. */
  card_id?: string | number;
  /** The masked card number, e.g. `624673******6680`. */
  card_number?: string | number;
  /** Their "Card Application Status" appendix. */
  card_status?: string | number;
  card_type_id?: string | number;
  /** Unix seconds. Not mapped — nothing in our schema has a home for it. */
  create_timestamp?: string | number;
  /** Their "Card application fail code" appendix. */
  fail_code?: string | number;
  fail_reason?: string | number;
}

/** The `data` payload of their "Application Result-v2" endpoint. */
export interface HyperCardApplicationResultData {
  mc_trade_no?: string | number;
  /**
   * Optional because nothing validates their payload against this type. A
   * success carrying no result object is read as "no outcome yet" rather than
   * asserted away.
   */
  result?: HyperCardApplicationResultRow;
}

/**
 * The `data` payload of their "Recharge" endpoint — an acknowledgement that a
 * request was accepted, not a statement that money moved.
 *
 * **`recharge_amount` here is not the `recharge_amount` we send.** On the
 * request it is the fiat going into the card; here it is the amount in the
 * payment coin, with the fiat under `currency_amount`.
 */
export interface HyperCardRechargeData {
  /** Their own id for the deposit, and the second handle a settlement lookup can check itself against. */
  order_no?: string | number;
  /** The fiat currency credited to the card. */
  card_coin?: string | number;
  /** The fiat amount received — the figure that corresponds to what we asked for. */
  currency_amount?: string | number;
  /** In the payment coin, **not** the card's currency. See the note above. */
  recharge_amount?: string | number;
  /** In the payment coin, after their fees. */
  real_recharge_amount?: string | number;
  recharge_fee_amount?: string | number;
  recharge_fee_usdt_amount?: string | number;
  pay_coin?: string | number;
  coin_exchange_usd_rate?: string | number;
  currency_exchange_usd_rate?: string | number;
}

/**
 * The `data` payload of their "Estimate crypto" endpoint. Its own type rather
 * than the recharge payload's, which carries the same fields today.
 *
 * It repeats the `recharge_amount` trap: on the request that field is the fiat
 * going into the card, here it is the amount in the payment coin.
 */
export interface HyperCardCryptoEstimateData {
  /** The fiat currency the card is credited in. */
  card_coin?: string | number;
  /** The fiat amount that would be received — what was asked for. */
  currency_amount?: string | number;
  /** In the payment coin, **not** the card's currency. See the note above. */
  recharge_amount?: string | number;
  /** In the payment coin, after their fees. Unmapped. */
  real_recharge_amount?: string | number;
  /** Their charge on the exchange, in the payment coin. */
  recharge_fee_amount?: string | number;
  /** Unmapped — indistinguishable from the fee above when the coin is usdt. */
  recharge_fee_usdt_amount?: string | number;
  /** The coin the deposit is paid with, echoed back. */
  pay_coin?: string | number;
  /** Unmapped: nothing consumes a rate. */
  coin_exchange_usd_rate?: string | number;
  currency_exchange_usd_rate?: string | number;
}

/**
 * The `data` payload of their "Recharge Query" endpoint — the only place a
 * deposit's outcome is observable. It repeats the same `recharge_amount` trap.
 */
export interface HyperCardRechargeQueryData {
  /** Their "Recharge status" appendix — see `HyperCardRechargeStatus`. */
  status?: string | number;
  /**
   * Their own words for a failure, carried only on their failure status. Empty
   * fields arrive as `""` rather than as an absent key.
   */
  fail_reason?: string | number;
  /** Their own id for the deposit, returned on acceptance as well as here. */
  order_no?: string | number;
  /** The fiat currency credited to the card. */
  card_coin?: string | number;
  /** The fiat amount that landed — the only field that may become a credited amount. */
  currency_amount?: string | number;
  /** In the payment coin, **not** the card's currency. See the note above. */
  recharge_amount?: string | number;
  /** In the payment coin, after their fees. */
  real_recharge_amount?: string | number;
  recharge_fee_amount?: string | number;
  recharge_fee_usdt_amount?: string | number;
  pay_coin?: string | number;
  coin_exchange_usd_rate?: string | number;
  currency_exchange_usd_rate?: string | number;
  card_id?: string | number;
  mc_trade_no?: string | number;
}

/**
 * Their "Recharge status" appendix — not to be confused with the card
 * application statuses above. Their appendix carries an explicit "is final
 * status" column, and only two of these five are true there.
 */
export const HyperCardRechargeStatus = {
  PENDING: 0,
  SUCCESS: 1,
  /** Theirs is explicitly **not** final: it can still become a refund. */
  FAIL: 2,
  TO_BE_REFUND: 3,
  REFUNDED: 4,
} as const;

/**
 * The integer vocabularies their "Card config list" endpoint returns, one
 * constant per appendix. Their codes stay inside this folder — what crosses
 * the port is the domain enum each maps onto.
 */

/** Their "Bank card type" appendix. */
export const HyperCardCardType = {
  VIRTUAL: 1,
  PHYSICAL: 2,
} as const;

/**
 * Their "Card Organization" appendix. Code 5 is spelled "Disconver" on their
 * page; it is Discover.
 */
export const HyperCardCardOrg = {
  VISA: 1,
  MASTERCARD: 2,
  AMERICAN_EXPRESS: 3,
  UNIONPAY: 4,
  DISCOVER: 5,
  JCB: 6,
} as const;

/** Their "Card material" appendix. */
export const HyperCardCardSubType = {
  METAL: 1,
  PLASTIC: 2,
} as const;

/**
 * Their "Application Type" appendix, named for the modes their own page names —
 * each code points at the application endpoint that serves it.
 */
export const HyperCardApplyType = {
  /** Their "Default mode": identity documents supplied inline. */
  DEFAULT: 1,
  /** Their "Express mode": no KYC container in the request at all. */
  EXPRESS: 2,
  /** Their "Binding mode": links a card the holder already has. */
  BINDING: 3,
  /** Their "Billing mode": documents inline plus a billing address. */
  BILLING: 4,
  /** Their "Online mode". Their page for it ships an empty description. */
  ONLINE: 5,
} as const;

/** Their "Method of Activation" appendix. */
export const HyperCardActivateType = {
  /** Their "Via API (need ID)" — the one case their Activation endpoint serves. */
  API_WITH_DOCUMENT: 1,
  /** Their "Via Email" — the issuer reaches the cardholder and we call nothing. */
  EMAIL: 2,
  /** Their "via API (no need ID)". See the mapper for why this one is a problem. */
  API_WITHOUT_DOCUMENT: 3,
} as const;

/**
 * Their integer boolean: 1 is yes across `status`, `can_recharge` and
 * `need_first_recharge`, each worded differently on their page for the same
 * encoding.
 */
export const HYPERCARD_FLAG_YES = 1;

/**
 * Their "Card Application Status" appendix — carried by `card_status` on their
 * "Application Result-v2" endpoint and by `old_status`/`new_status` on their
 * `CARD_STATUS_CHANGE` push event. The only card lifecycle enum they publish.
 */
export const HyperCardCardApplicationStatus = {
  OPENING_PRE_APPLY: 0,
  OPENING_PENDING_PAYMENT: 1,
  OPENING_REVIEWING: 2,
  OPENING_REVIEWED_SUCCESS: 3,
  OPENING_REVIEWED_REJECTED: 4,
  OPENING_REFUNDED: 5,
  OPENING_SHIPPED: 6,
  OPENING_ACTIVATING: 7,
  OPENING_ACTIVATION_FAILED: 8,
  OPENING_ACTIVATED: 9,
  /** Freeze applied by us; their appendix says it can be lifted via the API. */
  ACTIVE_FREEZE: 10,
  ACTIVATION_REVIEWING: 11,
  ACTIVATION_REVIEWED_REJECTED: 12,
  ACTIVATION_REVIEWED_SUCCESS: 13,
  CANCELLING: 14,
  CANCELLED: 15,
  /** Freeze applied by them; their appendix says it cannot be lifted via the API. */
  PASSIVE_FREEZE: 18,
  REFUND_REVIEWING: 21,
  REFUND_REVIEWED_REJECTED: 22,
  REFUND_REVIEWED_SUCCESS: 23,
  /** Awaiting a document upload through their attachment-upload endpoint. */
  OPENING_WAIT_ATTACHMENT: 24,
  /** Awaiting funds through their application-payment endpoint. */
  WAIT_FOR_RECHARGE: 30,
} as const;

/**
 * One row of their card statement, from their "Single card transaction-v2"
 * endpoint. Every field is `string | number` because their own two statement
 * pages disagree about which.
 */
export interface HyperCardTransactionRow {
  /** Their "Transaction type" appendix — see `HyperCardTransactionType`. */
  type?: string | number;
  /** Their "Transaction Status" appendix — see `HyperCardTransactionStatus`. */
  status?: string | number;
  /**
   * Their own id for the row. Their table declares it a string; **both** of
   * their statement examples publish it unquoted.
   */
  tx_id?: string | number;
  /**
   * Our own reference, echoed back — present only for transactions we
   * initiated, so a deposit is recognisable on the statement and a purchase is
   * not.
   */
  mc_trade_no?: string | number;
  /** The row's currency. Not necessarily fiat — see the note on the mapper. */
  tx_currency?: string | number;
  tx_amount?: string | number;
  /** What the row added to the card. */
  credit?: string | number;
  /** What the row took off it. */
  debit?: string | number;
  /** Their handling fee, in `tx_currency`. Applicable to certain card types only. */
  fee?: string | number;
  /** Their human-readable label — `"MONTHLY FEE"`. */
  description?: string | number;
  /** Unix timestamp in seconds. */
  transaction_date?: string | number;
  /** Unix timestamp in seconds. Their table calls this the submission date. */
  posting_date?: string | number;
}

/** One month's statement. Their endpoint answers with an array of these. */
export interface HyperCardStatement {
  bank_tx_list?: HyperCardTransactionRow[];
  /** Which period this statement covers, `MMyyyy`. */
  month_year?: string | number;
  statement_cycle_date?: string | number;
}

/**
 * Their "Transaction type" appendix — not the same thing as the transaction
 * query business type their merchant-wide query takes, nor the two-value
 * `tx_type` on their transfer pages.
 */
export const HyperCardTransactionType = {
  CONSUME: 1,
  RECHARGE: 2,
  WITHDRAWAL: 3,
  TRANSFER_IN: 4,
  TRANSFER_OUT: 5,
  OTHER: 6,
  SETTLEMENT_ADJUSTMENT: 7,
  REFUND: 8,
  PAYMENT_REVERSAL: 9,
  FEE: 10,
  FEE_REVERSAL: 11,
  OTC_REFUND: 12,
  OTC_REFUND_REVERSAL: 13,
  CONSUMPTION_FAILURE: 14,
  BINDING_CARD_VERIFICATION: 15,
  TRANSACTION_SERVICE_FEE: 16,
  RESCISSION: 17,
  DISPUTE_APPEAL_FAILED: 18,
  DISPUTE_APPEAL_SUCCEEDED: 19,
  CREDIT_CARD_BILL_RECONCILIATION: 100,
  PURCHASE_CRYPTO_COIN: 101,
  CANCEL_CARD: 102,
} as const;

/**
 * Their "Transaction Status" appendix. Three values, narrower than their
 * recharge statuses, which is why a deposit's whole lifecycle is not
 * observable from a statement row.
 */
export const HyperCardTransactionStatus = {
  IN_OPERATION: 0,
  SUCCESS: 1,
  FAIL: 2,
} as const;

/**
 * Every `notify_type` on their common push-event page. Twelve; the seven with
 * no handler are acknowledged and ignored, because refusing an event nothing
 * can act on earns their whole retry ladder.
 */
export const HyperCardNotifyType = {
  OPEN_CARD: 'OPEN_CARD',
  RECHARGE: 'RECHARGE',
  OPERATION: 'OPERATION',
  CARD_STATUS_CHANGE: 'CARD_STATUS_CHANGE',
  CARD_CONFIG_CHANGE: 'CARD_CONFIG_CHANGE',
  /** A card transaction. Transactions are read through to them and stored nowhere. */
  CONSUME: 'CONSUME',
  /** A change to one. Same reason. */
  TRANSACTION_CHANGE: 'TRANSACTION_CHANGE',
  BUY_COIN: 'BUY_COIN',
  CANCEL_CARD: 'CANCEL_CARD',
  AUTH_3DS: 'AUTH_3DS',
  OPT_CODE: 'OPT_CODE',
  /**
   * **The only one of theirs carrying a non-integer number** — `10.00000000`,
   * which does not survive `JSON.parse`, so acting on this event means reading
   * that number out of the body text rather than the parsed value.
   */
  CARD_CORRECTION_CHARGE: 'CARD_CORRECTION_CHARGE',
} as const;

/**
 * One inbound push, before anything has been read out of it. Optional and
 * `string | number` throughout, like every wire interface here.
 */
export interface HyperCardPushEvent {
  notify_type?: string | number;
  /** Their id for a card, on every event that concerns one. */
  card_id?: string | number;
  /** Our own reference, echoed back. **Optional on a card application.** */
  mc_trade_no?: string | number;
  /** Our own reference on a card operation, under a second name. */
  request_number?: string | number;
  /** Their "Card Application Status" ladder — the card's status now. */
  new_status?: string | number;
  /** Their view of the status before. Never read — see the mapper. */
  old_status?: string | number;
}
