import { GatewayCapability } from './gateway-capability.enum';
import { GatewayCredentials } from './gateway-credentials.model';
import { GatewayKey } from './gateway-key.enum';
import { PaymentIntent, ProviderRefs } from './payment-intent.model';
import { PaymentStatus } from './payment-status.enum';

export interface InitiatePaymentResult {
  kind: 'REDIRECT' | 'FORM_POST';
  url: string;
  params?: Readonly<Record<string, string>>;
  /**
   * The provider's own order/transaction reference, when it is already known at
   * initiation (some providers return it from the create call rather than only
   * on callback). Persisted to `payment_transaction.provider_ref` — without it,
   * a later status query or reconciliation has no id to look the order up by.
   */
  providerRef?: string;
}

/**
 * Everything an adapter may need to verify an inbound callback.
 *
 * `payload` alone is not sufficient for every provider: some sign the exact
 * request bytes and send the signature in a header, which a parsed object cannot
 * reproduce. Adapters take only what they need — MLT reads `payload`, SunPay
 * reads `rawBody` + `headers`.
 */
export interface GatewayCallbackContext {
  /** Parsed body. */
  payload: Readonly<Record<string, unknown>>;
  /**
   * The EXACT bytes received, unparsed. Never rebuild this by re-serializing
   * `payload` — key order and number formatting can differ and the signature
   * will not match.
   */
  rawBody: string;
  /** Request headers, keys lower-cased. */
  headers: Readonly<Record<string, string>>;
}

export interface GatewayResultVerification {
  signatureValid: boolean;
  status: PaymentStatus;
  refs: Partial<ProviderRefs>;
  reasonCode?: string;
  message?: string;
}

export interface GatewayStatusQueryResult {
  status: PaymentStatus;
  refs: Partial<ProviderRefs>;
  reasonCode?: string;
  message?: string;
}

export interface PaymentGatewayPort {
  readonly key: GatewayKey;
  readonly capabilities: ReadonlySet<GatewayCapability>;

  /**
   * True if this gateway's callback is delivered via the CUSTOMER'S BROWSER
   * being redirected/posted back (like MLT's redirection model) — in that
   * case the callback handler should redirect the browser onward to the
   * partner's configured checkout return page. False for pure
   * server-to-server callback gateways (no browser involved), where the
   * gateway's own expected ack (callbackAck()) must always be returned
   * instead.
   */
  readonly supportsBrowserRedirect: boolean;

  initiate(
    intent: PaymentIntent,
    credentials: GatewayCredentials,
  ): Promise<InitiatePaymentResult>;

  /**
   * Pulls OUR merchant reference (`requestId`) out of an inbound callback.
   *
   * Exists so the shared callback use-case never needs to know a provider's
   * field names — MLT puts it at top-level `RequestId`, SunPay nests it at
   * `data.out_order_no`. Returns null when the callback carries no recognisable
   * reference, which must be logged rather than treated as a match.
   */
  extractRequestId(context: GatewayCallbackContext): string | null;

  verifyResult(
    context: GatewayCallbackContext,
    credentials: GatewayCredentials,
  ): Promise<GatewayResultVerification>;

  queryStatus(
    refs: ProviderRefs,
    credentials: GatewayCredentials,
  ): Promise<GatewayStatusQueryResult>;

  /**
   * The exact response this provider expects after a callback. `contentType`
   * must describe `body` truthfully — MLT acks with the bare string `OK`,
   * SunPay with a JSON object, and mislabelling one as the other makes a
   * client parsing by header choke on the response. Defaults to `text/plain`.
   */
  callbackAck(): { status: number; body: string; contentType?: string };
}
