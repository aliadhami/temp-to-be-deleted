import { Injectable, Logger } from '@nestjs/common';
import { CardCapability } from '../../../domain/card-capability.enum';
import { CardProviderKey } from '../../../domain/card-provider-key.enum';
import {
  ActivateCardResult,
  CardApplicationOutcome,
  CardBalanceResult,
  CardCallbackContext,
  CardCallbackReading,
  CardDepositOutcome,
  CardDepositRequestResult,
  CardFundingQuoteResult,
  CardholderStatusResult,
  CardIssuerPort,
  CardLifecycleOperationResult,
  CardOperationOutcome,
  CardProductListing,
  MerchantBalanceResult,
  CardTransaction,
  CardTransactionsResult,
  DepositAddress,
  ListCardTransactionsParams,
  IssueCardResult,
  KycSubmissionResult,
  OnboardCardholderResult,
} from '../../../domain/card-issuer.port';
import { CardDepositIntent } from '../../../domain/card-deposit-intent.model';
import { CardFundingQuoteIntent } from '../../../domain/card-funding-quote-intent.model';
import { CardLifecycleOperation } from '../../../domain/card-lifecycle-operation.enum';
import { CardLifecycleOperationIntent } from '../../../domain/card-lifecycle-operation-intent.model';
import { CardProviderConflictError } from '../../../domain/card-provider-conflict.error';
import { CardProviderIntentRejectedError } from '../../../domain/card-provider-intent-rejected.error';
import { CardProviderThrottledError } from '../../../domain/card-provider-throttled.error';
import {
  isHyperCardRefusal,
  toHyperCardConflict,
} from './hypercard-refusal.util';
import { CardProviderUnsupportedOperationError } from '../../../domain/card-provider-unsupported-operation.error';
import {
  CardActivationIntent,
  CardIssuanceIntent,
} from '../../../domain/card-issuance-intent.model';
import { CardStatus } from '../../../domain/card-status.enum';
import { CardholderIntent } from '../../../domain/cardholder-intent.model';
import { CardholderStatus } from '../../../domain/cardholder-status.enum';
import { SensitiveCardDetails } from '../../../domain/sensitive-card-details';
import { resolveHyperCardApplicationPath } from './hypercard-application-mode.resolver';
import { assertHyperCardBaseInfo } from './hypercard-base-info.util';
import {
  buildHyperCardDeliveryKey,
  mapHyperCardCallbackEvent,
  readHyperCardCallbackLabel,
} from './hypercard-callback.mapper';
import { HyperCardCardDetailKeyService } from './hypercard-card-detail-key.service';
import { decryptHyperCardCardDetail } from './hypercard-card-detail.crypto';
import {
  HyperCardCardDetailError,
  mapHyperCardCardDetail,
} from './hypercard-card-detail.mapper';
import { mapHyperCardCardBalance } from './hypercard-card-balance.mapper';
import { mapHyperCardFundingQuote } from './hypercard-funding-quote.mapper';
import { mapHyperCardMerchantBalance } from './hypercard-merchant-balance.mapper';
import { mapHyperCardCardProducts } from './hypercard-card-product.mapper';
import {
  normaliseHyperCardAmount,
  normaliseHyperCardText,
} from './hypercard-coercion.util';
import { HyperCardHttpClient } from './hypercard-http-client.service';
import { mapHyperCardOperationStatus } from './hypercard-operation-status.mapper';
import { HyperCardPlatformKeyService } from './hypercard-platform-key.service';
import { HyperCardSignatureService } from './hypercard-signature.service';
import { mapHyperCardRechargeStatus } from './hypercard-recharge-status.mapper';
import {
  decodeHyperCardStatementCursor,
  encodeHyperCardStatementCursor,
  HyperCardStatementCursor,
  resolveHyperCardStatementWindow,
} from './hypercard-statement-window.util';
import {
  mapHyperCardTransaction,
  readHyperCardStatementRows,
  readHyperCardStatementRowSeconds,
} from './hypercard-transaction.mapper';
import { HyperCardApiError } from './hypercard-response.util';
import {
  mapHyperCardActivationStatus,
  mapHyperCardCardStatus,
  readHyperCardCardStatus,
} from './hypercard-status.mapper';
import { buildHyperCardTradeNumber } from './hypercard-trade-number.util';
import {
  HYPERCARD_CLIENT_ERROR_CODE,
  HYPERCARD_PARAMETER_ERROR_CODE,
  HyperCardApplicationResultData,
  HyperCardApplicationResultRow,
  HyperCardCardBalanceData,
  HyperCardCardDetailData,
  HyperCardCryptoEstimateData,
  HyperCardOperationResultData,
  HyperCardOperationType,
  HyperCardPushEvent,
  HyperCardRechargeData,
  HyperCardRechargeQueryData,
} from './hypercard.types';

/** Their "Card config list" endpoint. */
const CARD_LIST_PATH = '/v5/openapi/card/list';

/** Their "Application Result-v2" endpoint. */
const APPLICATION_RESULT_PATH = '/v2/openapi/card/apply/result';

/** Their "Activation" endpoint. */
const CARD_ACTIVATION_PATH = '/openapi/card/active';

/** Their "Bank card detail-v2" endpoint. */
const CARD_DETAIL_PATH = '/v2/openapi/card/bank/details';

/** Their "Balance Inquiry" endpoint. Exported: the live probe sends this request itself. */
export const HYPERCARD_CARD_BALANCE_PATH = '/openapi/card/balance';

/** Their "Merchant Balance" endpoint — our float with them. Exported for the live probe. */
export const HYPERCARD_MERCHANT_BALANCE_PATH = '/openapi/card/merchant/balance';

/**
 * Their "Single card transaction-v2" endpoint — the card statement. Not their
 * "Transaction Query-v3", despite the higher version.
 */
export const HYPERCARD_CARD_STATEMENT_PATH =
  '/v2/openapi/card/transaction/record';

/** Their "Card operation request" endpoint — every operation type shares it. */
const HYPERCARD_CARD_OPERATION_PATH = '/openapi/card/operation';

/** Their "Card Operation result" endpoint. Exported for the live probe. */
export const HYPERCARD_CARD_OPERATION_RESULT_PATH =
  '/v2/openapi/card/operation/result';

/** Their "Recharge" endpoint. */
const CARD_RECHARGE_PATH = '/openapi/card/recharge';

/** Their "Recharge Query" endpoint — the only place a deposit's outcome exists. */
const CARD_RECHARGE_QUERY_PATH = '/openapi/card/recharge/query';

/** Their "Estimate crypto" endpoint. Exported for the live probe. */
export const HYPERCARD_CRYPTO_ESTIMATE_PATH = '/openapi/card/estimation/crypto';

/**
 * What they count as having received a push. **Both halves are load-bearing**:
 * anything but 200 is a failed delivery, and a 200 not answering `code=1` is
 * retried anyway.
 */
const HYPERCARD_CALLBACK_ACK = Object.freeze({
  status: 200,
  body: JSON.stringify({ code: 1, msg: 'ok', data: {} }),
  contentType: 'application/json',
});

/**
 * The coin the merchant float is debited in when a deposit is made. Our
 * funding arrangement with the issuer, not a partner's choice — hence a
 * constant here rather than a field on the port.
 */
const HYPERCARD_RECHARGE_PAY_COIN = 'usdt';

/**
 * Their "Operation Type" appendix, for the two operations this adapter can
 * carry out. Their numbering stays inside this folder.
 */
const HYPERCARD_OPERATION_TYPE = {
  block: HyperCardOperationType.FREEZE,
  unblock: HyperCardOperationType.UNFREEZE,
} as const;

/** The two operation names this adapter speaks, either side of the map above. */
type HyperCardOperationName = keyof typeof HYPERCARD_OPERATION_TYPE;

/**
 * The two above, reached from the vocabulary a stored operation carries. Names
 * rather than integers, so their numbering stays written down exactly once.
 */
const HYPERCARD_OPERATION_NAME: Partial<
  Record<CardLifecycleOperation, HyperCardOperationName>
> = {
  [CardLifecycleOperation.BLOCK]: 'block',
  [CardLifecycleOperation.UNBLOCK]: 'unblock',
};

/** How much of an issuer's failure text is worth a log line. */
const LOGGED_FAILURE_MAX_LENGTH = 300;

/**
 * Statement rows per page when a caller names no limit. Matches the cap the
 * partner-facing query allows.
 */
const HYPERCARD_STATEMENT_DEFAULT_LIMIT = 50;

/** One mapped statement row, with the second it happened in. */
interface HyperCardStatementEntry {
  at: number;
  transaction: CardTransaction;
}

/**
 * Ordering for machine-generated identifiers. Not `localeCompare` — that
 * collates by the host's locale and ICU build, so two deployments could order
 * the same pair differently and drop or repeat a row at a page boundary.
 */
const compareIdentifiers = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Newest first, breaking a tie on the identifier. The tie-break is what makes
 * the cursor safe.
 */
const compareStatementEntriesNewestFirst = (
  left: HyperCardStatementEntry,
  right: HyperCardStatementEntry,
): number =>
  right.at - left.at ||
  compareIdentifiers(right.transaction.id, left.transaction.id);

/** Where the page after a cursor starts, in the ordering above. */
const isAfter =
  (cursor: HyperCardStatementCursor) =>
  (entry: HyperCardStatementEntry): boolean => {
    if (entry.at !== cursor.atSeconds) return entry.at < cursor.atSeconds;
    return compareIdentifiers(entry.transaction.id, cursor.id) < 0;
  };

/** Whitespace removed, for comparing a base64 key against the one we sent. */
const stripWhitespace = (value: unknown): string | null =>
  typeof value === 'string' ? value.replace(/\s+/g, '') : null;

/**
 * Makes an issuer's failure text safe to log on a request that carried a
 * document. Their messages echo request input.
 */
const summariseHyperCardFailure = (
  message: string,
  activationDocument: string,
): string => {
  const redacted = message.split(activationDocument).join('[document]');

  return redacted.length > LOGGED_FAILURE_MAX_LENGTH
    ? `${redacted.slice(0, LOGGED_FAILURE_MAX_LENGTH)}…`
    : redacted;
};

/** What their application-result lookup said. */
type HyperCardApplicationLookup =
  | { held: false }
  | { held: true; result: HyperCardApplicationResultRow | null };

/**
 * Thrown by a port method this adapter has not built. Typed so a caller can
 * tell it apart from `HyperCardApiError`, which means the call failed.
 */
export class HyperCardNotImplementedError extends Error {
  constructor(public readonly operation: string) {
    super(
      `HyperCard adapter does not implement ${operation} yet — it is scaffolded, and a method is implemented alongside its capability flag.`,
    );
    this.name = 'HyperCardNotImplementedError';
  }
}

/**
 * Thrown when a response describes something other than what was asked about.
 */
export class HyperCardResponseMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HyperCardResponseMismatchError';
  }
}

/**
 * The HyperCard card issuer (hyperpay.io — crypto-funded card issuing; not the
 * card-acquiring gateway at hyperpay.com, a different company entirely, which
 * would implement `PaymentGatewayPort`).
 */
/**
 * Their allowance wording: "You have already submitted an Freeze application.
 * Applications can only be submitted once within 24 hours."
 *
 * **Two independent fragments, neither spanning the templated operation
 * name**, so a reordering still lands on the right arm.
 */
const ALLOWANCE_SPENT_FRAGMENTS: readonly RegExp[] = [
  /already submitted/i,
  /once within \s*\d+\s*hours?/i,
];

@Injectable()
export class HyperCardAdapter implements CardIssuerPort {
  readonly key = CardProviderKey.HYPERCARD;

  /**
   * Exactly the capabilities whose methods exist below — never declared ahead
   * of the code behind it.
   */
  readonly capabilities: ReadonlySet<CardCapability> = new Set<CardCapability>([
    CardCapability.PRODUCT_CATALOGUE,
    CardCapability.ONBOARD_CARDHOLDER,
    // `ISSUE_PHYSICAL` stays undeclared — the issuance gate picks its
    // capability by the requested form factor, so a physical card is refused.
    CardCapability.ISSUE_VIRTUAL,
    CardCapability.APPLICATION_RESULT,
    // The card products on this account activate by identity check.
    CardCapability.ACTIVATE,
    // A virtual card has no plastic, so the number, security code and expiry
    // exist nowhere but behind this flag.
    CardCapability.SENSITIVE_REVEAL,
    // Covers two port methods rather than one — argued on the enum member.
    CardCapability.DEPOSIT,
    // They publish their own rate and their own fee, so a deposit's cost in the
    // funding coin is knowable only by asking them.
    CardCapability.FUNDING_QUOTE,
    // Enrols every active card of this issuer in a live call per sweep pass,
    // which is why that sweep is bounded.
    CardCapability.BALANCE_READ,
    CardCapability.MERCHANT_BALANCE_READ,
    // A request path rather than a timer, so it costs a live call only when a
    // partner asks for one.
    CardCapability.TRANSACTIONS_READ,
    // Freeze and unfreeze. Whether a given product accepts them is a second,
    // narrower question, answered by the product's own supported operations.
    CardCapability.BLOCK,
    // Separate from the flag above: they acknowledge, the bank then works the
    // request, and the outcome exists only in a later lookup.
    CardCapability.OPERATION_RESULT,
    // They post results to an address registered in their merchant backend.
    // The only thing here that learns of a change we did not ask for.
    CardCapability.CALLBACK_EVENTS,
  ]);

  private readonly logger = new Logger(HyperCardAdapter.name);

  constructor(
    private readonly httpClient: HyperCardHttpClient,
    private readonly cardDetailKeyService: HyperCardCardDetailKeyService,
    private readonly signatureService: HyperCardSignatureService,
    private readonly platformKeyService: HyperCardPlatformKeyService,
  ) {}

  /**
   * Calls HyperCard not at all, by design. Their application endpoints each
   * create the person and the card in one request and mint no cardholder
   * identifier, so there is nothing to ask them for.
   */
  onboardCardholder(
    intent: CardholderIntent,
  ): Promise<OnboardCardholderResult> {
    // The chain is what defers the throws below: a port method declared
    // `Promise<T>` that throws synchronously escapes a caller's `.catch()`.
    // `async` would say this more plainly but fails `require-await`.
    return Promise.resolve().then(() => {
      assertHyperCardBaseInfo(intent);

      return {
        providerCardholderId: buildHyperCardTradeNumber(intent.publicId),
        status: CardholderStatus.APPROVED,
      };
    });
  }

  /**
   * Structurally absent, not unbuilt — the one refusal here that is not a
   * `HyperCardNotImplementedError`, because nothing later implements it.
   */
  submitKyc(): Promise<KycSubmissionResult> {
    return Promise.reject(
      new CardProviderUnsupportedOperationError(
        this.key,
        'submitKyc',
        'this issuer has no separate KYC step — identity material, where a product requires any, is carried by the card application itself. Issue the card for this cardholder directly; there is nothing to submit beforehand',
      ),
    );
  }

  /**
   * Structurally absent, like `submitKyc` above: they hold no person, and
   * publish no endpoint keyed by one. `CARDHOLDER_STATUS` is undeclared to
   * match, which keeps the status sync away from here rather than letting it
   * write an answer composed locally over the stored one. An application's own
   * outcome is on `card_application`, carrying the issuer's code and reason.
   */
  queryCardholderStatus(): Promise<CardholderStatusResult> {
    return Promise.reject(
      new CardProviderUnsupportedOperationError(
        this.key,
        'queryCardholderStatus',
        'this issuer models no cardholder — a person exists here only in our own records, and only their individual card applications have an outcome to report',
      ),
    );
  }

  /**
   * Their "Application Result-v2" endpoint, read for the card. Resolved on the
   * card id, never on their status.
   */
  async getCardApplicationResult(
    requestId: string,
  ): Promise<CardApplicationOutcome> {
    // Re-derived rather than held in wire form, as a deposit's settlement
    // lookup is. Deterministic, so this is the number the application carried.
    const lookup = await this.fetchApplicationResult(
      buildHyperCardTradeNumber(requestId),
    );

    if (!lookup.held) return { state: 'UNKNOWN_REFERENCE' };

    const result = lookup.result;
    // Held, but nothing reported. Undocumented, and pending is the reading that
    // keeps the attempt alive — they have it, so there is something to come
    // back for.
    if (result === null) return { state: 'PENDING', rawPayload: {} };

    // A snapshot, not a reference into the parsed response: this is persisted
    // for replay, and the same reasoning as the catalogue's raw payload
    // applies — a JSON round trip is the identity function over a value that
    // came from `JSON.parse` and is going into a `json` column.
    const rawPayload = JSON.parse(JSON.stringify(result)) as Record<
      string,
      unknown
    >;

    const providerCardId = normaliseHyperCardText(result.card_id);
    const rawStatus = result.card_status ?? '';
    const status = mapHyperCardCardStatus(rawStatus);
    // Null exactly where the degrading read above substituted its default.
    const statusRecognised = readHyperCardCardStatus(rawStatus) !== null;
    const activation = mapHyperCardActivationStatus(rawStatus);
    const reasonCode = normaliseHyperCardText(result.fail_code);
    const reason = normaliseHyperCardText(result.fail_reason);

    if (providerCardId) {
      const maskedPan = normaliseHyperCardText(result.card_number);
      return {
        state: 'ISSUED',
        providerCardId,
        status,
        statusRecognised,
        // Conditional spread: under `exactOptionalPropertyTypes` an absent
        // optional cannot be set to undefined. Their card number has been seen
        // arriving after the card id, so an issued card with no masked number
        // yet is a real shape rather than a defensive one.
        ...(maskedPan && { maskedPan }),
        // The same pair carries an activation refusal, not only a review one,
        // hence reading it before the refusal branch below.
        ...(reasonCode && { reasonCode }),
        ...(reason && { reason }),
        // Only where their code is about an activation attempt. Their codes
        // for an unactivated card that has none are ordinary here, so this is
        // absent far more often than it is present.
        ...(activation && { activation }),
        rawPayload,
      };
    }

    if (status === CardStatus.CLOSED) {
      return {
        state: 'REJECTED',
        ...(reasonCode && { reasonCode }),
        ...(reason && { reason }),
        rawPayload,
      };
    }

    return { state: 'PENDING', rawPayload };
  }

  /**
   * The one call both readings above are made from, returning their `result`
   * object or null when they do not hold the reference.
   */
  private async fetchApplicationResult(
    requestId: string,
  ): Promise<HyperCardApplicationLookup> {
    try {
      const data = await this.httpClient.post<HyperCardApplicationResultData>(
        'card application result',
        APPLICATION_RESULT_PATH,
        { mc_trade_no: requestId },
      );

      // A success carrying no result object is not a shape they document. The
      // transport's type argument is what a caller expects, and nothing
      // validates the body against it — so the shape is checked, not asserted.
      return { held: true, result: data.result ?? null };
    } catch (error) {
      if (
        error instanceof HyperCardApiError &&
        error.code === HYPERCARD_PARAMETER_ERROR_CODE
      ) {
        return { held: false };
      }

      throw error;
    }
  }

  /**
   * Their application endpoints. HyperCard opens the person and the card in
   * one request, so onboarding and issuance are one call there and two port
   * methods here; `onboardCardholder` above stages the person locally and
   * sends nothing. Their application carries no cardholder field — the person
   * is identified by the contact details in `base_info` — so the reference is
   * unread.
   */
  async issueCard(
    _providerCardholderId: string,
    intent: CardIssuanceIntent,
  ): Promise<IssueCardResult> {
    const cardProduct = intent.cardProduct;
    if (!cardProduct) {
      // Unreachable through the issuance path, which resolves a product first.
      throw new CardProviderIntentRejectedError(
        this.key,
        'cardProduct',
        'this issuer opens a card against a catalogue product, so an application cannot be sent without one',
      );
    }

    const path = resolveHyperCardApplicationPath(cardProduct.applicationMode);
    const { applicant } = intent;

    await this.httpClient.postForAck('card application', path, {
      // Derived from the card, not the person: their result lookup answers one
      // outcome per transaction number, so a cardholder's second card would
      // take the first one's outcome. The derivation also keeps it clear of the
      // deposits sharing this namespace; the result lookup re-derives it.
      mc_trade_no: buildHyperCardTradeNumber(intent.publicId),
      base_info: {
        card_type_id: cardProduct.providerProductId,
        email: applicant.email,
        first_name: applicant.firstName,
        last_name: applicant.lastName,
        mobile: applicant.cellNumber,
        mobile_code: applicant.callingCode,
        // Conditional spreads: under `exactOptionalPropertyTypes` an absent
        // optional cannot be set to undefined, and sending an explicit null for
        // a field their page marks optional invites a parameter error.
        ...(applicant.userIp && { user_ip: applicant.userIp }),
        ...(intent.initialDepositAmount && {
          first_recharge_amount: intent.initialDepositAmount,
        }),
      },
    });

    // No `providerCardId` and no `maskedPan` keys at all — absent means "not
    // known yet" on this port, and under `exactOptionalPropertyTypes` they
    // cannot be set to undefined to say the same thing.
    return { status: CardStatus.NOT_ACTIVATED };
  }

  /**
   * Their "Activation" endpoint — what the card products on this account need,
   * since those activate by identity check.
   */
  async activateCard(
    intent: CardActivationIntent,
  ): Promise<ActivateCardResult> {
    const activationDocument = intent.activationDocument;
    if (!activationDocument) {
      throw new CardProviderIntentRejectedError(
        this.key,
        'activationDocument',
        'this issuer activates a card by identity check, so activation needs a base64 photograph of the cardholder holding their identity document and the card',
      );
    }

    try {
      await this.httpClient.postForAck(
        'card activation',
        CARD_ACTIVATION_PATH,
        { card_id: intent.providerCardId, file: activationDocument },
      );
    } catch (error) {
      if (
        error instanceof HyperCardApiError &&
        error.code === HYPERCARD_PARAMETER_ERROR_CODE
      ) {
        throw this.refuseActivationDocument(error, activationDocument);
      }

      throw error;
    }

    return { status: CardStatus.NOT_ACTIVATED };
  }

  /**
   * Turns their parameter error on the activation endpoint into a refusal that
   * names our own field, leaving everything else as it was. Safe only because
   * of this endpoint's shape.
   */
  private refuseActivationDocument(
    error: HyperCardApiError,
    activationDocument: string,
  ): CardProviderIntentRejectedError {
    this.logger.warn(
      `HyperCard refused a card activation: ${summariseHyperCardFailure(error.message, activationDocument)}`,
    );

    return new CardProviderIntentRejectedError(
      this.key,
      'activationDocument',
      // "most likely" rather than a flat assertion: the request also carries
      // the card id, and an issuer can stop holding a card it once named. The
      // document is the only value a partner can act on, so it leads.
      'the issuer rejected this activation request, most likely the document — it must be raw base64 (no "data:" prefix) of a jpg, jpeg or png photograph of the cardholder holding their identity document and the card. If the document is known good, the card may no longer be open at the issuer',
      { cause: error },
    );
  }

  /**
   * Their "Bank card detail-v2" endpoint — the only way a partner learns a
   * virtual card's number, since there is no plastic to read one off. They
   * never return a plaintext detail.
   */
  async revealSensitiveCardDetails(
    providerCardId: string,
  ): Promise<SensitiveCardDetails> {
    const { privateKey, publicKeyBase64 } =
      await this.cardDetailKeyService.resolve();

    const data = await this.httpClient.post<HyperCardCardDetailData>(
      'bank card detail',
      CARD_DETAIL_PATH,
      { card_id: providerCardId, pub_key: publicKeyBase64 },
    );

    // The card id first, because it answers "whose card is this". Anything
    // else means the payload about to be decrypted describes a card the caller
    // did not ask for, and this route returns a full card number.
    if (typeof data.card_id === 'number') {
      throw new HyperCardCardDetailError(
        'HyperCard echoed the card id as a JSON number. Their ids are twenty digits, so the value lost precision when the response was parsed and cannot be checked against the card this request asked about.',
      );
    }
    if (normaliseHyperCardText(data.card_id) !== providerCardId) {
      throw new HyperCardCardDetailError(
        'HyperCard echoed a different card id than the one this request asked about — the card detail cannot be trusted to describe this card',
      );
    }

    // A plain comparison, deliberately: this is a public key travelling in
    // clear, so it is neither a secret nor a signature.
    if (stripWhitespace(data.pub_key) !== publicKeyBase64) {
      throw new HyperCardCardDetailError(
        'HyperCard echoed a different public key than the one this request sent — the card detail cannot be trusted to have been encrypted under ours',
      );
    }

    if (typeof data.encoded_card_detail !== 'string') {
      throw new HyperCardCardDetailError(
        'HyperCard returned a card detail response carrying no encoded_card_detail',
      );
    }

    return mapHyperCardCardDetail(
      data,
      decryptHyperCardCardDetail(privateKey, data.encoded_card_detail),
    );
  }

  /**
   * Their "Estimate crypto" endpoint — what an opening deposit costs in the
   * coin it is funded with. Keyed on their card type, so nothing need exist yet
   * to be priced.
   */
  async quoteCardFunding(
    providerProductId: string,
    intent: CardFundingQuoteIntent,
  ): Promise<CardFundingQuoteResult> {
    // Before the request: they publish no timestamp, so this is when the
    // question was asked.
    const quotedAt = new Date();

    let data: HyperCardCryptoEstimateData;
    try {
      data = await this.httpClient.post<HyperCardCryptoEstimateData>(
        'card funding estimate',
        HYPERCARD_CRYPTO_ESTIMATE_PATH,
        {
          card_type_id: providerProductId,
          pay_coin: HYPERCARD_RECHARGE_PAY_COIN,
          // Fiat here; the same field comes back in the payment coin.
          recharge_amount: intent.depositAmount,
        },
      );
    } catch (error) {
      // Their parameter error is generic. Reading it as a refusal is safe here
      // only because the request carries three values and two are ours.
      if (isHyperCardRefusal(error, [HYPERCARD_PARAMETER_ERROR_CODE])) {
        throw this.refuseFundingQuote(error, providerProductId);
      }
      throw error;
    }

    // An echo they stopped sending would leave the guard in the mapper
    // permanently inert, and silently.
    if (normaliseHyperCardText(data.pay_coin) === null) {
      this.logger.warn(
        `HyperCard priced product ${providerProductId} without echoing pay_coin — the coin this cost is denominated in is assumed to be the one that was asked for`,
      );
    }

    const quote = mapHyperCardFundingQuote(data, {
      payCoin: HYPERCARD_RECHARGE_PAY_COIN,
      cardCurrencyCode: intent.currencyCode,
      quotedAt,
    });

    // A warning where the coin throws: this currency reaches the response, so
    // a mismatch is visible to the partner rather than hidden.
    if (
      quote.credited.currencyCode.toUpperCase() !==
      intent.currencyCode.toUpperCase()
    ) {
      this.logger.warn(
        `HyperCard priced product ${providerProductId} in ${quote.credited.currencyCode} for a product denominated in ${intent.currencyCode}`,
      );
    }

    return quote;
  }

  /** Their parameter error on the estimate endpoint, as a refusal a partner can act on. */
  private refuseFundingQuote(
    error: HyperCardApiError,
    providerProductId: string,
  ): CardProviderIntentRejectedError {
    this.logger.warn(
      `HyperCard refused to price a deposit on product ${providerProductId}: ${error.message}`,
    );

    return new CardProviderIntentRejectedError(
      this.key,
      'initialDepositAmount',
      // "may" rather than a flat assertion: the request also carries the
      // product, which they can stop offering while our catalogue still holds it.
      'the issuer would not price this deposit — the amount may be outside what it accepts for this product, or it may no longer offer the product at all',
      { cause: error },
    );
  }

  /**
   * Their "Recharge" endpoint — money onto an existing card, drawn from the
   * merchant float we hold with them.
   */
  async requestCardDeposit(
    providerCardId: string,
    intent: CardDepositIntent,
  ): Promise<CardDepositRequestResult> {
    // Intersected with an index signature so the payload can be handed back for
    // replay without a cast: an interface has none of its own, and the double
    // assertion that would otherwise be needed is exactly the kind that stops
    // reporting when the shape changes.
    const data = await this.httpClient.postForOptionalData<
      HyperCardRechargeData & Record<string, unknown>
    >('card recharge', CARD_RECHARGE_PATH, {
      card_id: providerCardId,
      // Derived here rather than sent as-is: their transaction-number namespace
      // is shared with the card applications, and the derivation is what keeps
      // a deposit from colliding with one. The settlement lookup re-derives
      // from the same stored reference.
      mc_trade_no: buildHyperCardTradeNumber(intent.reference),
      pay_coin: HYPERCARD_RECHARGE_PAY_COIN,
      recharge_amount: intent.amount,
      // Spread rather than sent as null: an absent optional cannot be set to
      // undefined under `exactOptionalPropertyTypes`, and an explicit null on
      // a field their page marks optional invites a parameter error.
      ...(intent.remark && { remark: intent.remark }),
    });

    if (!data) {
      // Their documented empty payload. There is no identifier to record and
      // nothing to replay, but the request was accepted — the caller's row
      // moves to submitted either way, and the settlement lookup is keyed on
      // the reference we sent rather than on anything returned here.
      this.logger.warn(
        `HyperCard accepted a deposit for card ${providerCardId} and returned no payload — their documented response for a card that is not yet open`,
      );
      return { rawPayload: null };
    }

    this.warnOnCurrencyMismatch(providerCardId, intent, data);

    const providerDepositId = this.identifierFrom(data.order_no, 'order_no');

    return {
      // Absent rather than null: "not reported" is what the port's optional
      // means, and their page does not promise this field on every acceptance.
      ...(providerDepositId && { providerDepositId }),
      rawPayload: data,
    };
  }

  /**
   * Their "Recharge Query" endpoint — what became of an accepted deposit. This
   * exists because their recharge response carries no status at all, so
   * settlement is observable here and nowhere else.
   */
  async getCardDepositResult(
    providerCardId: string,
    reference: string,
  ): Promise<CardDepositOutcome> {
    const data = await this.fetchRechargeResult(providerCardId, reference);

    // Their success with no payload. Read as "they do not hold this reference"
    // rather than as an outcome: their page documents a full object here, so an
    // empty one says nothing was found to describe.
    if (data === null) return { state: 'UNKNOWN_REFERENCE' };

    // A snapshot rather than a reference into the parsed response, for the
    // reason the application-result lookup records: this is persisted for
    // replay, and a JSON round trip is the identity function over a value that
    // came from `JSON.parse` and is going into a `json` column.
    const rawPayload = JSON.parse(JSON.stringify(data)) as Record<
      string,
      unknown
    >;

    // Before anything is read for meaning: a payload describing another deposit
    // must not reach a caller at all, and the two identifiers they echo are the
    // only thing that can say it does.
    this.assertRechargeQueryEcho(
      providerCardId,
      buildHyperCardTradeNumber(reference),
      data,
    );

    const providerDepositId = this.identifierFrom(data.order_no, 'order_no');
    // Conditional spread throughout: under `exactOptionalPropertyTypes` an
    // absent optional cannot be set to undefined, and their empty values arrive
    // as `""` rather than as missing keys.
    const identifier = providerDepositId ? { providerDepositId } : {};

    const state = mapHyperCardRechargeStatus(data.status);

    switch (state) {
      case 'SETTLED': {
        const creditedAmount = normaliseHyperCardAmount(data.currency_amount);
        if (creditedAmount === null) {
          // A success with no readable fiat figure is a payload we do not
          // understand, and both alternatives are worse than asking again:
          // settling with no amount records a credit of unknown size, and
          // settling with the coin figure records the funding account's cost
          // as the cardholder's money.
          this.logger.warn(
            `HyperCard reported deposit ${reference} on card ${providerCardId} as settled with no readable credited amount — leaving it to be asked about again`,
          );
          return { state: 'PENDING', ...identifier, rawPayload };
        }

        const creditedCurrencyCode = normaliseHyperCardText(data.card_coin);

        return {
          state: 'SETTLED',
          creditedAmount,
          ...(creditedCurrencyCode && { creditedCurrencyCode }),
          ...identifier,
          rawPayload,
        };
      }

      case 'FAILED': {
        // Their page states this field carries a value on their failure status
        // and is empty otherwise, so it is read only here. They have no failure
        // *code* on this endpoint — unlike their application result, which
        // publishes both — so the reason travels alone.
        const reason = normaliseHyperCardText(data.fail_reason);

        return {
          state: 'FAILED',
          ...(reason && { reason }),
          ...identifier,
          rawPayload,
        };
      }

      case 'REFUND_PENDING':
      case 'REFUNDED':
        return { state, ...identifier, rawPayload };

      // Their pending status, and anything the mapper did not recognise. Both
      // mean "come back", which is why they share an arm.
      case 'PENDING':
      case null:
        return { state: 'PENDING', ...identifier, rawPayload };
    }
  }

  /**
   * One of their identifiers, refused rather than coerced when it arrives as a
   * JSON number. The opposite of what the integer vocabularies get, and the
   * reason is length.
   */
  private identifierFrom(raw: unknown, field: string): string | null {
    if (typeof raw === 'number') {
      this.logger.warn(
        `HyperCard sent ${field} as a JSON number, which their identifiers are too long to survive — ignoring the value rather than storing a rounded one`,
      );
      return null;
    }

    return normaliseHyperCardText(raw);
  }

  /** Refuses a settlement payload that describes a different deposit. */
  private assertRechargeQueryEcho(
    providerCardId: string,
    tradeNumber: string,
    data: HyperCardRechargeQueryData,
  ): void {
    const echoedCardId = this.identifierFrom(data.card_id, 'card_id');
    if (echoedCardId !== null && echoedCardId !== providerCardId) {
      throw new HyperCardResponseMismatchError(
        `HyperCard answered a recharge query for card ${providerCardId} with a payload describing card ${echoedCardId} — the settlement cannot be trusted to describe this deposit`,
      );
    }

    const echoedReference = this.identifierFrom(
      data.mc_trade_no,
      'mc_trade_no',
    );
    if (echoedReference !== null && echoedReference !== tradeNumber) {
      throw new HyperCardResponseMismatchError(
        `HyperCard answered a recharge query for reference ${tradeNumber} with a payload carrying reference ${echoedReference} — the settlement cannot be trusted to describe this deposit`,
      );
    }
  }

  /**
   * The one call above is made from, returning their payload or null when they
   * do not hold the reference.
   */
  private async fetchRechargeResult(
    providerCardId: string,
    reference: string,
  ): Promise<(HyperCardRechargeQueryData & Record<string, unknown>) | null> {
    return this.httpClient.postForOptionalData<
      HyperCardRechargeQueryData & Record<string, unknown>
    >('card recharge query', CARD_RECHARGE_QUERY_PATH, {
      card_id: providerCardId,
      // Re-derived from the stored reference rather than stored twice: the
      // derivation is deterministic, so the number they were given on the
      // request is the number they are asked by here.
      mc_trade_no: buildHyperCardTradeNumber(reference),
    });
  }

  /** Logs when the currency they say they credited is not the card's. */
  private warnOnCurrencyMismatch(
    providerCardId: string,
    intent: CardDepositIntent,
    data: HyperCardRechargeData,
  ): void {
    const creditedCurrency = normaliseHyperCardText(data.card_coin);
    if (!creditedCurrency) return;
    if (creditedCurrency.toUpperCase() === intent.currencyCode.toUpperCase()) {
      return;
    }

    this.logger.warn(
      `HyperCard credited card ${providerCardId} in ${creditedCurrency} for a deposit recorded in ${intent.currencyCode}`,
    );
  }

  /**
   * No HyperCard equivalent exists. Axys assigns persistent per-chain deposit
   * addresses; HyperCard inverts the model — recharge, then a crypto quote,
   * then payment — so there is no persistent address to return.
   */
  getDepositAddresses(): Promise<DepositAddress[]> {
    return Promise.reject(
      new HyperCardNotImplementedError('getDepositAddresses'),
    );
  }

  /**
   * Their "Balance Inquiry" endpoint — what the card holds, read on demand.
   * Narrower than the port, which allows `null`, deliberately.
   */
  async getCardBalance(providerCardId: string): Promise<CardBalanceResult> {
    const observedAt = new Date();

    const data = await this.httpClient.post<HyperCardCardBalanceData>(
      'card balance inquiry',
      HYPERCARD_CARD_BALANCE_PATH,
      { card_id: providerCardId },
    );

    return mapHyperCardCardBalance(data, observedAt);
  }

  /** Their "Merchant Balance" endpoint — our own account with them, never a card's. */
  async getMerchantBalance(): Promise<MerchantBalanceResult> {
    const observedAt = new Date();

    // `coin` is deliberately not sent: a read pinned to one coin reports zero
    // while another holds funds.
    const data = await this.httpClient.postForOptionalData<unknown>(
      'merchant balance inquiry',
      HYPERCARD_MERCHANT_BALANCE_PATH,
      {},
    );

    return mapHyperCardMerchantBalance(data, observedAt);
  }

  /**
   * Their "Card operation request" endpoint. **Acceptance is not application**:
   * they answer a receipt and carry the operation out afterwards, so this only
   * ever returns the submitted arm and the card's status is never touched here.
   *
   * Their two frozen states both map to `ON_HOLD` and only one is liftable
   * through their API, so an unblock is submitted for either and a
   * passively-frozen card fails with no reason — their operation result
   * carries no reason field at all.
   */
  async updateCardStatus(
    providerCardId: string,
    intent: CardLifecycleOperationIntent,
  ): Promise<CardLifecycleOperationResult> {
    const operation = intent.status === 'on_hold' ? 'block' : 'unblock';

    try {
      // `postForAck`, not `post` or `postForOptionalData`: their page documents
      // `code` and `msg` and no `data` at all, so a missing payload is neither
      // the caller's mistake nor a meaningful outcome.
      await this.httpClient.postForAck(
        `card ${operation}`,
        HYPERCARD_CARD_OPERATION_PATH,
        {
          card_id: providerCardId,
          // Derived, never sent as-is. Their operation and deposit reference
          // fields may be one namespace — deriving both from distinct canonical
          // UUIDs keeps it injective either way.
          request_number: buildHyperCardTradeNumber(intent.reference),
          type: HYPERCARD_OPERATION_TYPE[operation],
          // `sign_img` and `address` belong to their card-replacement type and
          // are not sent. There is no field for a block reason on this
          // endpoint, so `intent.reason` has nowhere to go.
        },
      );
    } catch (error) {
      if (isHyperCardRefusal(error, [HYPERCARD_CLIENT_ERROR_CODE])) {
        throw this.refuseOperation(error, operation);
      }

      throw error;
    }

    return { state: 'SUBMITTED', operation, reference: intent.reference };
  }

  /**
   * Their generic client error as a refusal the caller can act on. **Safe only
   * here**: on this endpoint that code always means they declined, where
   * elsewhere it also covers a reference they do not hold.
   */
  private refuseOperation(
    error: HyperCardApiError,
    operation: HyperCardOperationName,
  ): CardProviderConflictError | CardProviderThrottledError {
    this.logger.warn(`HyperCard refused a card ${operation}: ${error.message}`);

    // Matched on prose, because one code carries both. A rewording of theirs
    // lands on the conflict arm, which is the safe direction.
    return ALLOWANCE_SPENT_FRAGMENTS.every((fragment) =>
      fragment.test(error.message),
    )
      ? new CardProviderThrottledError(this.key, error.code, error.message, {
          cause: error,
        })
      : toHyperCardConflict(error);
  }

  /**
   * Their "Card Operation result" endpoint — the only place an operation's
   * outcome exists, their request answering a receipt and nothing else.
   *
   * **The not-held arm is never constructed here.** They cannot express it: one
   * generic code covers a reference they do not hold, a malformed request and a
   * mismatched card or operation alike, so reading it as "no such operation"
   * would let one bad lookup retire a real operation for ever.
   */
  async getCardOperationResult(
    providerCardId: string,
    reference: string,
    operation: CardLifecycleOperation,
  ): Promise<CardOperationOutcome> {
    const name = HYPERCARD_OPERATION_NAME[operation];
    if (!name) {
      throw new CardProviderUnsupportedOperationError(
        this.key,
        'getCardOperationResult',
        `it carries out no ${operation} operation, so there is no outcome of one to look up`,
      );
    }

    const tradeNumber = buildHyperCardTradeNumber(reference);
    const data = await this.fetchOperationResult(
      providerCardId,
      tradeNumber,
      HYPERCARD_OPERATION_TYPE[name],
    );

    // Their generic client error, read as "no outcome yet".
    if (data === null) return { state: 'PENDING' };

    // A snapshot, not a reference into the parsed response: this is persisted
    // for replay.
    const rawPayload = JSON.parse(JSON.stringify(data)) as Record<
      string,
      unknown
    >;

    // Before anything is read for meaning: a payload describing another
    // operation must not reach a caller at all.
    this.assertOperationResultEcho(providerCardId, tradeNumber, data);

    // `express_company` and `express_no` are never read — their card
    // replacement's, and present and empty on everything else.
    const state = mapHyperCardOperationStatus(data.operate_status);

    if (state === 'FAILED') {
      // No reason field on this endpoint at all, unlike their recharge lookup,
      // so a caller composes what a partner reads.
      return { state: 'FAILED', rawPayload };
    }

    // Their pending statuses, and anything the mapper did not recognise: both
    // mean "come back", which is why they share an arm.
    if (state === null) return { state: 'PENDING', rawPayload };

    return { state, rawPayload };
  }

  /** The one call above is made from. Null on their generic client error. */
  private async fetchOperationResult(
    providerCardId: string,
    tradeNumber: string,
    type: number,
  ): Promise<(HyperCardOperationResultData & Record<string, unknown>) | null> {
    try {
      // `post`, not `postForOptionalData`: unlike their recharge query, an
      // unknown reference here is an error code rather than an empty success,
      // so a missing payload is not a meaningful outcome.
      return await this.httpClient.post<
        HyperCardOperationResultData & Record<string, unknown>
      >('card operation result', HYPERCARD_CARD_OPERATION_RESULT_PATH, {
        card_id: providerCardId,
        // Re-derived rather than stored twice; the derivation is deterministic.
        request_number: tradeNumber,
        // **All three are the lookup key.** A wrong card or a wrong type
        // answers as an unknown reference does, so a guessed operation would
        // read as no outcome rather than as a mistake.
        type,
      });
    } catch (error) {
      if (
        error instanceof HyperCardApiError &&
        error.code === HYPERCARD_CLIENT_ERROR_CODE
      ) {
        // `debug`, not `warn`: this is their ordinary "not ready" answer, met
        // on most polls of most rows. A lost reference surfaces through the
        // pass's tally and its escalation instead.
        this.logger.debug(
          `HyperCard answered their generic client error for operation ${tradeNumber} on card ${providerCardId} — it covers both a reference they do not hold and a request they could not read, so the operation is left to be asked about again: ${error.message}`,
        );
        return null;
      }

      throw error;
    }
  }

  /** Refuses a result payload that describes a different operation. */
  private assertOperationResultEcho(
    providerCardId: string,
    tradeNumber: string,
    data: HyperCardOperationResultData,
  ): void {
    const echoedCardId = this.identifierFrom(data.card_id, 'card_id');
    if (echoedCardId !== null && echoedCardId !== providerCardId) {
      throw new HyperCardResponseMismatchError(
        `HyperCard answered an operation result query for card ${providerCardId} with a payload describing card ${echoedCardId} — the outcome cannot be trusted to describe this operation`,
      );
    }

    const echoedReference = this.identifierFrom(
      data.request_number,
      'request_number',
    );
    if (echoedReference !== null && echoedReference !== tradeNumber) {
      throw new HyperCardResponseMismatchError(
        `HyperCard answered an operation result query for reference ${tradeNumber} with a payload carrying reference ${echoedReference} — the outcome cannot be trusted to describe this operation`,
      );
    }
  }

  /**
   * Only partly expressible. This port method takes the current PIN; HyperCard
   * offers reset operations only, one of which additionally requires a follow-
   * up to their "Pin Query" endpoint.
   */
  updateCardPin(): Promise<CardLifecycleOperationResult> {
    return Promise.reject(new HyperCardNotImplementedError('updateCardPin'));
  }

  /**
   * Their "Single card transaction-v2" endpoint — the card's own statement.
   * They publish no pagination on this endpoint at all.
   */
  async getCardTransactions(
    providerCardId: string,
    params: ListCardTransactionsParams,
  ): Promise<CardTransactionsResult> {
    const cursor = params.cursor
      ? decodeHyperCardStatementCursor(params.cursor)
      : null;
    const window = resolveHyperCardStatementWindow(
      params,
      cursor,
      Math.floor(Date.now() / 1000),
    );

    // `postForOptionalData`, not `post`: a card that has never transacted is a
    // legitimate "nothing here", which their endpoints express by answering
    // with no `data` at all.
    const data = await this.httpClient.postForOptionalData<unknown>(
      'card statement inquiry',
      HYPERCARD_CARD_STATEMENT_PATH,
      {
        card_id: providerCardId,
        start_time: window.startTime,
        end_time: window.endTime,
      },
    );

    // Windowed before mapping, not after. Their statements are whole months,
    // so an answer reaches past both ends of the requested range; mapping
    // first would let one malformed row from a month nobody asked about fail
    // the whole request.
    const entries = readHyperCardStatementRows(data)
      .filter((row) => {
        const at = readHyperCardStatementRowSeconds(row);
        return (
          at === null || (at >= window.fromSeconds && at <= window.toSeconds)
        );
      })
      .map((row) => {
        const transaction = mapHyperCardTransaction(row);
        return {
          // Read once here and carried, rather than re-parsed by the sort, the
          // cursor and the resumption test — which would also tie all three to
          // how `createdAt` happens to be rendered.
          at: Math.floor(Date.parse(transaction.createdAt) / 1000),
          transaction,
        };
      })
      .sort(compareStatementEntriesNewestFirst);

    const start = cursor ? entries.findIndex(isAfter(cursor)) : 0;
    const remaining = start === -1 ? [] : entries.slice(start);

    const limit = params.limit ?? HYPERCARD_STATEMENT_DEFAULT_LIMIT;
    const page = remaining.slice(0, limit);
    const last = page[page.length - 1];

    return {
      items: page.map((entry) => entry.transaction),
      nextCursor:
        last && remaining.length > page.length
          ? encodeHyperCardStatementCursor({
              window,
              atSeconds: last.at,
              id: last.transaction.id,
            })
          : null,
    };
  }

  /**
   * Their "Card config list" endpoint — unlike Axys, HyperCard has a real
   * catalogue, and it is why the port carries this method.
   */
  async listCardProducts(): Promise<CardProductListing[]> {
    const data = await this.httpClient.postForOptionalData<unknown>(
      'card config list',
      CARD_LIST_PATH,
      {},
    );

    return mapHyperCardCardProducts(data);
  }

  /**
   * Verifies one of their push events and says what it is about.
   *
   * **No freshness window**: a retry may carry the original's timestamp, so
   * any short window would reject the deliveries retrying exists to save.
   */
  async readCallback(
    context: CardCallbackContext,
  ): Promise<CardCallbackReading> {
    const body = context.payload as HyperCardPushEvent;

    // An unreachable or unset secret throws rather than reading as a bad
    // signature: it is our misconfiguration, and mislabelling it sends the
    // next reader into the verifier. A malformed key is different — `verify`
    // answers false for that.
    const platformPublicKeyPem = await this.platformKeyService.resolve();
    const signatureValid = this.signatureService.verify(
      context.headers,
      context.payload as Record<string, unknown>,
      platformPublicKeyPem,
    );

    return {
      signatureValid,
      deliveryKey: buildHyperCardDeliveryKey(
        context.payload as Record<string, unknown>,
      ),
      label: readHyperCardCallbackLabel(body),
      // Read on the refused path too: what a delivery claimed to be is what
      // diagnoses a failed verification.
      event: mapHyperCardCallbackEvent(body),
    };
  }

  callbackAck(): { status: number; body: string; contentType: string } {
    return HYPERCARD_CALLBACK_ACK;
  }
}
