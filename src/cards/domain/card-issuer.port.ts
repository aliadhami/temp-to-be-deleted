import { CardActivationStatus } from './card-activation-status.enum';
import { CardCapability } from './card-capability.enum';
import { CardProviderCredentials } from './card-provider-credentials.model';
import { CardProviderKey } from './card-provider-key.enum';
import { CardDepositIntent } from './card-deposit-intent.model';
import { CardFundingQuoteIntent } from './card-funding-quote-intent.model';
import { CardLifecycleOperation } from './card-lifecycle-operation.enum';
import { CardLifecycleOperationIntent } from './card-lifecycle-operation-intent.model';
import {
  CardActivationIntent,
  CardIssuanceIntent,
} from './card-issuance-intent.model';
import { CardholderIntent } from './cardholder-intent.model';
import { CardProduct, CurrencyOrCoinCode } from './card-product.model';
import { CardStatus } from './card-status.enum';
import { CardholderStatus } from './cardholder-status.enum';
import { SensitiveCardDetails } from './sensitive-card-details';

export interface OnboardCardholderResult {
  providerCardholderId: string;
  status: CardholderStatus;
  kycUrl?: string;
}

export interface KycSubmissionResult {
  status: CardholderStatus;
  kycUrl?: string;
}

export interface CardholderStatusResult {
  status: CardholderStatus;
  reason?: string;
}

export interface IssueCardResult {
  /** Absent means "not known yet" — an async issuer mints it later. */
  providerCardId?: string;
  status: CardStatus;
  /** Optional for the same reason as `providerCardId` — see above. */
  maskedPan?: string;
}

export interface ActivateCardResult {
  status: CardStatus;
}

export interface DepositAddress {
  chain: string;
  address: string;
}

/**
 * An issuer's acknowledgement of a deposit request — receipt, nothing more.
 * No amount and no status: what landed comes from the settlement lookup.
 */
export interface CardDepositRequestResult {
  /** The issuer's own identifier, when it returns one. */
  providerDepositId?: string;
  /** The acknowledgement as it arrived, for replay. Null on an empty payload. */
  rawPayload: Record<string, unknown> | null;
}

/**
 * What an issuer's settlement lookup says about one deposit. `FAILED` is not
 * terminal — a failed deposit is refunded, so a caller that stops asking there
 * reports money gone that in fact came back.
 */
export type CardDepositOutcome =
  /** No outcome yet. The deposit is live and worth asking about again. */
  | {
      state: 'PENDING';
      providerDepositId?: string;
      rawPayload: Record<string, unknown>;
    }
  /** The issuer credited the card. Terminal. */
  | {
      state: 'SETTLED';
      /** Decimal string in the currency below — not the funding coin. */
      creditedAmount: string;
      /** Check against the recorded currency rather than assuming they agree. */
      creditedCurrencyCode?: string;
      providerDepositId?: string;
      rawPayload: Record<string, unknown>;
    }
  /** Refused after acceptance. **Not terminal** — see above. */
  | {
      state: 'FAILED';
      reasonCode?: string;
      reason?: string;
      providerDepositId?: string;
      rawPayload: Record<string, unknown>;
    }
  /** The issuer has undertaken to return the money and has not yet done so. Not terminal. */
  | {
      state: 'REFUND_PENDING';
      providerDepositId?: string;
      rawPayload: Record<string, unknown>;
    }
  /** The money went back. Terminal. */
  | {
      state: 'REFUNDED';
      providerDepositId?: string;
      rawPayload: Record<string, unknown>;
    }
  /** They do not hold this reference — distinct from `PENDING`. */
  | { state: 'UNKNOWN_REFERENCE' };

/** An amount and the currency or coin it is denominated in. */
export interface CardFundingAmount {
  /** Decimal string, never a JS `number`. */
  amount: string;
  currencyCode: CurrencyOrCoinCode;
}

/**
 * What one opening deposit costs in the coin it is funded with. **No
 * `rawPayload`** — nothing persists a quote, so there is nothing to replay.
 */
export interface CardFundingQuoteResult {
  /** In the card's own currency. */
  credited: CardFundingAmount;
  /** In the funding coin, `fee` included. */
  cost: CardFundingAmount;
  fee: CardFundingAmount;
  /** When the question was asked — issuers publish no validity window. */
  quotedAt: string;
}

export interface CardBalanceResult {
  available: string;
  ledger: string;
  currencyCode: string;
  observedAt: string;
}

/**
 * One asset's balance on **our own account with an issuer**, never a card's.
 * Decimal strings, never a JS `number`.
 */
export interface MerchantBalanceEntry {
  currencyCode: CurrencyOrCoinCode;
  available: string;
  ledger: string;
}

export interface MerchantBalanceResult {
  /** Empty means the issuer holds nothing for us, not that the read failed. */
  entries: MerchantBalanceEntry[];
  observedAt: string;
}

/** Which lifecycle call an issuer is reporting on. */
export type CardLifecycleOperationName =
  | 'activate'
  | 'block'
  | 'unblock'
  | 'update_pin';

/**
 * What an issuer said about a block, unblock or PIN change. **A union, because
 * an issuer that carries the operation out during the call and one that only
 * takes it on cannot report the same thing** — the second has no card status
 * to give, and a single `status` field would make it invent one.
 */
export type CardLifecycleOperationResult =
  /** The issuer carried it out. The card really is at `status` now. */
  | {
      state: 'APPLIED';
      operation: CardLifecycleOperationName;
      status: CardStatus;
      /** false on an idempotent replay — the card was already there. */
      updated: boolean;
    }
  /**
   * The issuer took the request on and will carry it out later — the same
   * standing `CardOperationStatus.SUBMITTED` records, and named for it.
   * **No `status`, deliberately**: the card is untouched for as long as the
   * issuer takes, and an adapter here has nothing to report but the receipt.
   */
  | {
      state: 'SUBMITTED';
      operation: CardLifecycleOperationName;
      /** The reference the issuer's own result lookup will answer on. */
      reference: string;
    };

/**
 * What an issuer's operation-result lookup says about one lifecycle operation it
 * acknowledged. `CardLifecycleOperationResult` answers the request; this answers
 * whether it was carried out.
 */
export type CardOperationOutcome =
  /** No outcome yet. Live, and worth asking about again. */
  | { state: 'PENDING'; rawPayload?: Record<string, unknown> }
  /**
   * The issuer carried it out. Terminal. **No card status**: an issuer reports
   * on the operation, so where the card lands is read from what was asked for.
   */
  | { state: 'APPLIED'; rawPayload: Record<string, unknown> }
  /**
   * Taken on and not carried out. Terminal — unlike a deposit's failure, there
   * is nothing to refund. Several issuers report no reason, so a caller
   * composes one.
   */
  | {
      state: 'FAILED';
      reasonCode?: string;
      reason?: string;
      rawPayload: Record<string, unknown>;
    }
  /** They do not hold this reference — distinct from `PENDING`. */
  | { state: 'UNKNOWN_REFERENCE' };

export type CardBlockReason =
  | 'lost'
  | 'stolen'
  | 'customer_request'
  | 'fraud_review'
  | 'compliance'
  | 'other';

/**
 * One row of an issuer's card statement. Amounts are decimal strings in the
 * currency's own units (`"14.99"`, never `"1499"`); an adapter publishing
 * minor units converts on the way out.
 */
export interface CardTransaction {
  id: string;
  amount: string;
  currencyCode: string;
  status: string;
  category: string;
  /**
   * The issuer's own label for the row. Kept apart from `merchantName` so a
   * fee's label never reads as the merchant who charged it.
   */
  description?: string;
  merchantName: string | null;
  merchantAmount: string | null;
  merchantCurrency: string | null;
  createdAt: string;
  settledAt: string | null;
}

export interface CardTransactionsResult {
  items: CardTransaction[];
  /** **Opaque, owned by the adapter that minted it.** Null when there is none. */
  nextCursor: string | null;
}

export interface ListCardTransactionsParams {
  limit?: number;
  before?: number;
  after?: number;
  cursor?: string;
}

/**
 * One catalogue entry: the normalised product plus the issuer's own response.
 * `rawPayload` is deliberately not on `CardProduct`, which is the provider-
 * neutral type a partner response is projected from.
 */
export interface CardProductListing {
  product: CardProduct;
  /** Persisted for replay; never projected into a response, never read for meaning. */
  rawPayload: Record<string, unknown>;
}

/**
 * What an issuer's application-result lookup says about one attempt. An
 * issuer's own status is not the discriminator — one advances status and
 * identifiers independently, reporting an approved application whose card id
 * is still empty.
 */
export type CardApplicationOutcome =
  /** No outcome yet. The attempt is live and worth asking about again. */
  | { state: 'PENDING'; rawPayload: Record<string, unknown> }
  /** The issuer opened a card. `providerCardId` is what every later call is keyed on. */
  | {
      state: 'ISSUED';
      providerCardId: string;
      status: CardStatus;
      /**
       * **False when `status` is a withholding default the adapter
       * substituted** for a code it could not read, not an answer.
       *
       * A caller only ever moving a card *towards* activation may ignore it.
       * **One that would move a card in any direction must not**, or an
       * unreadable code walks a live card backwards.
       */
      statusRecognised: boolean;
      maskedPan?: string;
      /**
       * Why the card has not progressed. Present on an issued card too: an
       * activation refusal is not a rejection of the attempt — the card exists
       * and a later attempt can clear the fault.
       */
      reasonCode?: string;
      reason?: string;
      /**
       * Where an activation attempt stands, for an issuer that publishes an
       * activation stage of its own. **Absent means "no information", never
       * "nothing is pending"** — an issuer can go on reporting a card's
       * pre-activation state for a while after accepting one, so a reader that
       * cleared a stored `PENDING` here would clear it during the very window
       * it exists for.
       */
      activation?: CardActivationStatus;
      rawPayload: Record<string, unknown>;
    }
  /** The issuer refused the attempt. No card exists and none will from this attempt. */
  | {
      state: 'REJECTED';
      reasonCode?: string;
      reason?: string;
      rawPayload: Record<string, unknown>;
    }
  /** They do not hold this reference — distinct from `PENDING`. */
  | { state: 'UNKNOWN_REFERENCE' };

/**
 * Everything an adapter needs to read one inbound provider callback.
 *
 * **No raw body, deliberately** — `GatewayCallbackContext` next door carries
 * the exact bytes because a gateway there signs them; an issuer signing a
 * canonical string built from parsed fields gets nothing from them.
 */
export interface CardCallbackContext {
  /** Parsed body, exactly as received. */
  payload: Readonly<Record<string, unknown>>;
  /** Request headers, keys lower-cased. */
  headers: Readonly<Record<string, string>>;
}

/**
 * What one callback is about, in this codebase's vocabulary — an issuer's own
 * event names, references and status codes stay inside its adapter.
 *
 * **A trigger, never a source of truth**: no arm carries an outcome, bar the
 * status change's fallback reading — see that arm.
 */
export type CardCallbackEvent =
  /** An application attempt has an outcome. `reference` is a `card_application.request_id`. */
  | { kind: 'APPLICATION'; reference: string }
  /**
   * A deposit has an outcome. `reference` is a `card_deposit.provider_reference`
   * — **never `request_id`**, which is the partner's own idempotency key and
   * was never sent to the issuer.
   */
  | { kind: 'DEPOSIT'; reference: string }
  /** A lifecycle operation has an outcome. `reference` is a `card_operation.request_reference`. */
  | { kind: 'OPERATION'; reference: string }
  /**
   * The issuer moved a card itself. **`status` is a fallback, not the
   * answer**: no lookup is addressable by card, so the handler asks by the
   * card's application reference and writes this only when that fails.
   */
  | { kind: 'CARD_STATUS'; providerCardId: string; status: CardStatus }
  /** The issuer changed its product catalogue. */
  | { kind: 'PRODUCT_CATALOGUE' }
  /**
   * Nothing here acts on this delivery: an event type nothing handles, or a
   * handled one whose own fields cannot be read. Issuers add types, so this
   * arm is the difference between ignoring one and failing on it.
   */
  | { kind: 'UNHANDLED'; label: string | null };

/** What an adapter made of one inbound callback. */
export interface CardCallbackReading {
  /** False refuses the delivery. It is never trusted for having reached the route. */
  signatureValid: boolean;
  /**
   * What makes two arrivals the same delivery. Derived from the body alone, so
   * a retry carrying a fresh timestamp still collides with its original.
   */
  deliveryKey: string;
  /** The issuer's own name for the event, as received. Null if it carried none. */
  label: string | null;
  event: CardCallbackEvent;
}

export interface CardIssuerPort {
  readonly key: CardProviderKey;
  readonly capabilities: ReadonlySet<CardCapability>;

  onboardCardholder(
    intent: CardholderIntent,
    credentials: CardProviderCredentials,
    idempotencyKey?: string,
  ): Promise<OnboardCardholderResult>;

  submitKyc(
    providerCardholderId: string,
    credentials: CardProviderCredentials,
    idempotencyKey?: string,
  ): Promise<KycSubmissionResult>;

  /** Requires CardCapability.CARDHOLDER_STATUS. */
  queryCardholderStatus(
    providerCardholderId: string,
    credentials: CardProviderCredentials,
  ): Promise<CardholderStatusResult>;

  issueCard(
    providerCardholderId: string,
    intent: CardIssuanceIntent,
    credentials: CardProviderCredentials,
    idempotencyKey?: string,
  ): Promise<IssueCardResult>;

  activateCard(
    intent: CardActivationIntent,
    credentials: CardProviderCredentials,
    idempotencyKey?: string,
  ): Promise<ActivateCardResult>;

  revealSensitiveCardDetails(
    providerCardId: string,
    credentials: CardProviderCredentials,
  ): Promise<SensitiveCardDetails>;

  /** Requires CardCapability.DEPOSIT_ADDRESS. */
  getDepositAddresses(
    providerCardId: string,
    credentials: CardProviderCredentials,
  ): Promise<DepositAddress[]>;

  /**
   * Requires CardCapability.DEPOSIT. Puts money on an existing card from our
   * account with the issuer.
   */
  requestCardDeposit(
    providerCardId: string,
    intent: CardDepositIntent,
    credentials: CardProviderCredentials,
  ): Promise<CardDepositRequestResult>;

  /**
   * Requires CardCapability.DEPOSIT — the same flag as `requestCardDeposit`.
   * Asks what became of an accepted deposit.
   */
  getCardDepositResult(
    providerCardId: string,
    reference: string,
    credentials: CardProviderCredentials,
  ): Promise<CardDepositOutcome>;

  /**
   * Requires CardCapability.FUNDING_QUOTE. **Keyed on the product, not on a
   * card** — nothing need exist yet to be quoted.
   */
  quoteCardFunding(
    providerProductId: string,
    intent: CardFundingQuoteIntent,
    credentials: CardProviderCredentials,
  ): Promise<CardFundingQuoteResult>;

  /** Requires CardCapability.BALANCE_READ. */
  getCardBalance(
    providerCardId: string,
    credentials: CardProviderCredentials,
  ): Promise<CardBalanceResult | null>;

  /**
   * Requires CardCapability.MERCHANT_BALANCE_READ. Our own account with the
   * issuer — no card and no partner.
   */
  getMerchantBalance(
    credentials: CardProviderCredentials,
  ): Promise<MerchantBalanceResult>;

  /** Requires CardCapability.BLOCK. */
  updateCardStatus(
    providerCardId: string,
    intent: CardLifecycleOperationIntent,
    credentials: CardProviderCredentials,
    idempotencyKey?: string,
  ): Promise<CardLifecycleOperationResult>;

  /**
   * Requires CardCapability.OPERATION_RESULT. Asks what became of a lifecycle
   * operation an issuer only acknowledged. Takes the operation as well as the
   * reference, an issuer's lookup being keyed on all three.
   */
  getCardOperationResult(
    providerCardId: string,
    reference: string,
    operation: CardLifecycleOperation,
    credentials: CardProviderCredentials,
  ): Promise<CardOperationOutcome>;

  /** Requires CardCapability.PIN_MANAGEMENT. */
  updateCardPin(
    providerCardId: string,
    pinChangeRequestId: string,
    oldPin: string,
    newPin: string,
    credentials: CardProviderCredentials,
    idempotencyKey?: string,
  ): Promise<CardLifecycleOperationResult>;

  /** Requires CardCapability.TRANSACTIONS_READ. */
  getCardTransactions(
    providerCardId: string,
    params: ListCardTransactionsParams,
    credentials: CardProviderCredentials,
  ): Promise<CardTransactionsResult>;

  /**
   * Requires CardCapability.PRODUCT_CATALOGUE. Returns the whole catalogue.
   */
  listCardProducts(
    credentials: CardProviderCredentials,
  ): Promise<CardProductListing[]>;

  /**
   * Requires CardCapability.APPLICATION_RESULT. Asks what became of one
   * application, for issuers that answer separately from the call that made
   * it.
   */
  getCardApplicationResult(
    requestId: string,
    credentials: CardProviderCredentials,
  ): Promise<CardApplicationOutcome>;

  /**
   * Requires CardCapability.CALLBACK_EVENTS. Verifies one inbound callback and
   * says what it is about. **Never throws for a bad signature** — an
   * unverifiable delivery is a refused delivery, reported through
   * `signatureValid`, not a server fault.
   */
  readCallback(context: CardCallbackContext): Promise<CardCallbackReading>;

  /**
   * Requires CardCapability.CALLBACK_EVENTS. The response this issuer expects
   * after a callback it considers delivered. **An issuer may make the body
   * load-bearing as well as the status**, so satisfying one is not satisfying
   * the other.
   */
  callbackAck(): { status: number; body: string; contentType: string };
}
