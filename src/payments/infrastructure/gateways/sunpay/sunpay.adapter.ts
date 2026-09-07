import { Injectable, Logger } from '@nestjs/common';
import { GatewayCapability } from '../../../domain/gateway-capability.enum';
import { GatewayCredentials } from '../../../domain/gateway-credentials.model';
import { GatewayKey } from '../../../domain/gateway-key.enum';
import {
  PaymentIntent,
  ProviderRefs,
} from '../../../domain/payment-intent.model';
import { PaymentStatus } from '../../../domain/payment-status.enum';
import {
  GatewayCallbackContext,
  GatewayResultVerification,
  GatewayStatusQueryResult,
  InitiatePaymentResult,
  PaymentGatewayPort,
} from '../../../domain/payment-gateway.port';
import { SunPayHttpClient } from './sunpay-http-client.service';
import {
  SUNPAY_HEADERS,
  SunPaySignatureService,
} from './sunpay-signature.service';
import {
  isSunPayAmountSufficient,
  mapSunPayOrderStatus,
  mapSunPayWebhookStatus,
} from './sunpay-status.mapper';
import { resolveSunPayConfig } from './sunpay.config';
import {
  SUNPAY_WEBHOOK_ACK,
  SunPayCryptoPayInCreateData,
  SunPayCryptoPayInQueryData,
  SunPayCryptoPayInRequest,
  SunPayWebhookPayload,
} from './sunpay.types';

const CRYPTO_PAYIN_PATH = '/api/v3-1/Crypto/PayIn';

/** SunPay: max 64 chars, letters/digits/underscore only. */
const OUT_ORDER_NO_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Converts our canonical decimal-string amount into the JSON number SunPay
 * expects. Amounts are MAJOR units (20 = 20 USDT) — SunPay has no minor-unit
 * mode. Throws rather than silently losing precision, because a wrong amount is
 * worse than a failed request.
 */
export const toSunPayAmount = (decimalString: string): number => {
  if (!/^\d+(\.\d+)?$/.test(decimalString.trim())) {
    throw new Error(
      `SunPay amount "${decimalString}" is not a positive decimal string`,
    );
  }
  const asNumber = Number(decimalString);
  if (!Number.isFinite(asNumber) || asNumber <= 0) {
    throw new Error(`SunPay amount "${decimalString}" is not a usable value`);
  }
  // Round-trip check: if the double can't represent this decimal exactly, the
  // request would silently charge a different amount.
  if (!isSunPayAmountSufficient(decimalString, String(asNumber))) {
    throw new Error(
      `SunPay amount "${decimalString}" cannot be represented exactly as a JSON number`,
    );
  }
  if (!isSunPayAmountSufficient(String(asNumber), decimalString)) {
    throw new Error(
      `SunPay amount "${decimalString}" cannot be represented exactly as a JSON number`,
    );
  }
  return asNumber;
};

@Injectable()
export class SunPayAdapter implements PaymentGatewayPort {
  private readonly logger = new Logger(SunPayAdapter.name);

  readonly key = GatewayKey.SUNPAY;

  /**
   * Crypto pay-in only for now. SunPay also offers payout and refund
   * (Card Acquiring), but neither is implemented — advertising a capability we
   * can't service would let a use-case route real money into a dead end.
   */
  readonly capabilities: ReadonlySet<GatewayCapability> = new Set([
    GatewayCapability.COLLECT,
  ]);

  /**
   * False: SunPay's result arrives as a server-to-server webhook, not via the
   * customer's browser. The customer IS redirected to `payment_url` at
   * initiation, but that's the checkout hand-off — it is not how we learn the
   * outcome, which is what this flag governs.
   */
  readonly supportsBrowserRedirect = false;

  constructor(
    private readonly httpClient: SunPayHttpClient,
    private readonly signatureService: SunPaySignatureService,
  ) {}

  async initiate(
    intent: PaymentIntent,
    credentials: GatewayCredentials,
  ): Promise<InitiatePaymentResult> {
    const config = resolveSunPayConfig(credentials);

    const outOrderNo = intent.refs.requestId;
    if (!OUT_ORDER_NO_PATTERN.test(outOrderNo)) {
      // Sanitizing silently would break the link between their order and ours,
      // so this has to surface as a request error the partner can act on.
      throw new Error(
        `requestId "${outOrderNo}" is not valid as a SunPay out_order_no — max 64 chars, letters/digits/underscore only`,
      );
    }

    const body: SunPayCryptoPayInRequest = {
      out_order_no: outOrderNo,
      // Their per-merchant user reference. We send the partner's public UUID,
      // never the internal sequential id.
      out_user_id: intent.partnerPublicId ?? intent.partnerId ?? 'UNKNOWN',
      amount: toSunPayAmount(intent.amount),
      chain_type: intent.chainType ?? config.defaultChain,
      currency: intent.currency,
      webhook_url: intent.callbackUrl,
    };

    const data = await this.httpClient.post<SunPayCryptoPayInCreateData>(
      CRYPTO_PAYIN_PATH,
      body,
      config,
    );

    if (!data.payment_url) {
      throw new Error(
        `SunPay created order ${data.order_no} but returned no payment_url`,
      );
    }

    return {
      kind: 'REDIRECT',
      url: data.payment_url,
      // Persisted to provider_ref — without it, queryStatus has no id to use.
      providerRef: data.order_no,
      params: {
        order_no: data.order_no,
        out_order_no: data.out_order_no,
        chain_type: data.chain_type,
        currency: data.currency,
        // The deposit address, so a caller can render a QR without a second
        // round-trip. Note the query endpoint calls this same value
        // `to_address`.
        address: data.address ?? '',
        amount: String(data.amount ?? ''),
        expires_in: String(data.expires_in ?? ''),
      },
    };
  }

  /**
   * Extracts OUR requestId from a SunPay webhook. Their identifier for it is
   * `data.out_order_no` — nested, and named nothing like MLT's top-level
   * `RequestId`. This method exists so the shared callback use-case never has
   * to know either provider's field names.
   */
  extractRequestId(context: GatewayCallbackContext): string | null {
    const payload = context.payload as unknown as Partial<SunPayWebhookPayload>;
    const outOrderNo = payload?.data?.out_order_no;
    return typeof outOrderNo === 'string' && outOrderNo.length > 0
      ? outOrderNo
      : null;
  }

  /**
   * Verifies an inbound SunPay webhook.
   *
   * Signature is HMAC-SHA256 over the RAW request bytes, presented in the
   * `SunPay-Sign` header — hence the need for `rawBody`/`headers` rather than a
   * parsed object.
   *
   * Beyond the signature, this is where UNDERPAYMENT is caught. SunPay sends
   * both `amount` and `actual_payment_amount`; `biz_status: SUCCESS` on its own
   * is NOT proof we received what we asked for, because crypto lets the customer
   * send any amount. Comparing them here — on the path that actually runs — is
   * the difference between settling correctly and crediting money that never
   * arrived.
   */
  verifyResult(
    context: GatewayCallbackContext,
    credentials: GatewayCredentials,
  ): Promise<GatewayResultVerification> {
    const config = resolveSunPayConfig(credentials);

    const timestamp = context.headers[SUNPAY_HEADERS.TIMESTAMP.toLowerCase()];
    const nonce = context.headers[SUNPAY_HEADERS.NONCE.toLowerCase()];
    const presentedSignature =
      context.headers[SUNPAY_HEADERS.SIGN.toLowerCase()];

    const signatureValid =
      !!timestamp &&
      !!nonce &&
      !!presentedSignature &&
      this.signatureService.verify({
        timestamp,
        nonce,
        rawBody: context.rawBody,
        apiSecret: config.apiSecret,
        presentedSignature,
      });

    const payload = context.payload as unknown as Partial<SunPayWebhookPayload>;
    const data = payload?.data;
    const refs = data?.order_no ? { providerRef: data.order_no } : {};

    if (!signatureValid) {
      // Caller logs the callback regardless and refuses to touch the ledger.
      return Promise.resolve({
        signatureValid: false,
        status: PaymentStatus.ERROR,
        refs,
        reasonCode: 'BAD_SIGNATURE',
        message: 'SunPay webhook signature did not verify',
      });
    }

    const status = mapSunPayWebhookStatus(payload?.biz_status);
    const expected = data?.amount === undefined ? '' : String(data.amount);
    const actual =
      data?.actual_payment_amount === undefined
        ? ''
        : String(data.actual_payment_amount);

    if (
      status === PaymentStatus.PAID &&
      expected &&
      actual &&
      !isSunPayAmountSufficient(expected, actual)
    ) {
      this.logger.warn(
        `SunPay webhook for order ${data?.order_no} reported SUCCESS but underpaid: expected ${expected}, received ${actual}`,
      );
      // Deliberately NOT PaymentStatus.PAID: crediting an underpayment is worse
      // than flagging it. ERROR withholds settlement and surfaces it to a human.
      return Promise.resolve({
        signatureValid: true,
        status: PaymentStatus.ERROR,
        refs,
        reasonCode: 'UNDERPAID',
        message: `Underpaid: expected ${expected} ${data?.currency ?? ''}, received ${actual}`,
      });
    }

    return Promise.resolve({
      signatureValid: true,
      status,
      refs,
      ...(payload?.biz_status && { reasonCode: payload.biz_status }),
    });
  }

  async queryStatus(
    refs: ProviderRefs,
    credentials: GatewayCredentials,
  ): Promise<GatewayStatusQueryResult> {
    const config = resolveSunPayConfig(credentials);

    // The query endpoint is keyed on SunPay's own order_no, not ours.
    const orderNo = refs.providerRef;
    if (!orderNo) {
      throw new Error(
        `Cannot query SunPay status for requestId "${refs.requestId}" — no provider_ref (SunPay order_no) was stored`,
      );
    }

    const data = await this.httpClient.get<SunPayCryptoPayInQueryData>(
      `${CRYPTO_PAYIN_PATH}/${encodeURIComponent(orderNo)}`,
      config,
    );

    const status = mapSunPayOrderStatus(data.order_status);
    const expected = String(data.amount ?? '');
    const actual = String(data.actual_payment_amount ?? '');

    // Crypto lets the customer send the wrong amount. SunPay reporting SUCCESS
    // is not on its own proof we received what we asked for.
    if (
      status === PaymentStatus.PAID &&
      expected &&
      actual &&
      !isSunPayAmountSufficient(expected, actual)
    ) {
      this.logger.warn(
        `SunPay order ${orderNo} reported SUCCESS but underpaid: expected ${expected}, received ${actual}`,
      );
      // There is no UNDERPAID in PaymentStatus, and the two plausible
      // alternatives are both wrong: PAID would credit money we didn't receive,
      // FAILED would discard funds that genuinely arrived. ERROR is the honest
      // mapping — it withholds settlement and flags the row for a human, which
      // is exactly what a partial crypto payment needs.
      return {
        status: PaymentStatus.ERROR,
        refs: { providerRef: data.order_no },
        reasonCode: 'UNDERPAID',
        message: `Underpaid: expected ${expected} ${data.currency}, received ${actual}`,
      };
    }

    return {
      status,
      refs: { providerRef: data.order_no },
      ...(data.order_status && { reasonCode: data.order_status }),
    };
  }

  callbackAck(): { status: number; body: string; contentType: string } {
    return {
      status: 200,
      body: JSON.stringify(SUNPAY_WEBHOOK_ACK),
      contentType: 'application/json',
    };
  }
}
