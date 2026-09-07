import { Injectable } from '@nestjs/common';
import { GatewayCapability } from '../../../domain/gateway-capability.enum';
import { GatewayCredentials } from '../../../domain/gateway-credentials.model';
import { GatewayKey } from '../../../domain/gateway-key.enum';
import {
  GatewayCallbackContext,
  GatewayResultVerification,
  GatewayStatusQueryResult,
  InitiatePaymentResult,
  PaymentGatewayPort,
} from '../../../domain/payment-gateway.port';
import {
  PaymentIntent,
  ProviderRefs,
} from '../../../domain/payment-intent.model';
import { mapMltCardStatus } from './mlt-status.mapper';
import { formatMltTimestamp } from './mlt-timestamp.util';
import { MltSecureHashService } from './mlt-secure-hash.service';
import { MltRequestFields, MltResponseFields } from './mlt.types';
import { resolveMltGatewayUrl } from './mlt.config';

const CARD_SIGNATURE_FIELDS =
  'RequestId,TimeStamp,ReferenceNumber,MerchantId,Amount';

@Injectable()
export class MltAdapter implements PaymentGatewayPort {
  readonly key = GatewayKey.MLT;
  readonly capabilities = new Set<GatewayCapability>([
    GatewayCapability.COLLECT,
    GatewayCapability.REFUND,
  ]);
  readonly supportsBrowserRedirect = true;

  constructor(private readonly secureHashService: MltSecureHashService) {}

  async initiate(
    intent: PaymentIntent,
    credentials: GatewayCredentials,
  ): Promise<InitiatePaymentResult> {
    const timeStamp = formatMltTimestamp(new Date());
    const gatewayUrl = resolveMltGatewayUrl(credentials);

    const baseFields: Record<string, string> = {
      MerchantId: credentials.MERCHANT_ID ?? '',
      UserId: credentials.USER_ID ?? '',
      Password: credentials.PASSWORD ?? '',
      TimeStamp: timeStamp,
      SourceApplication: 'WebApplication',
      RequestCategory: 'sale',
      Language: 'EN',
      PaymentChannel: credentials.PAYMENT_CHANNEL ?? 'OCD',
      RequestId: intent.refs.requestId,
      ReferenceNumber: intent.refs.referenceNumber,
      Currency: intent.currency,
      Amount: intent.amount,
      CallBackUrl: intent.callbackUrl,
      EncryptionAlgo: 'AES',
      SignatureFields: CARD_SIGNATURE_FIELDS,
    };

    if (intent.customer.name) {
      const nameParts = intent.customer.name.split(' ');
      const firstName = nameParts[0];
      if (firstName) {
        baseFields.FirstName = firstName;
      }
      if (nameParts.length > 1) {
        baseFields.LastName = nameParts.slice(1).join(' ');
      }
    }
    if (intent.customer.email) baseFields.CustomerEmail = intent.customer.email;
    if (intent.customer.country)
      baseFields.CustomerCountry = intent.customer.country;

    const secureHash = this.secureHashService.generate(
      baseFields,
      CARD_SIGNATURE_FIELDS,
      credentials.SECRET_KEY ?? '',
    );

    return {
      kind: 'FORM_POST',
      url: `${gatewayUrl}/Gateway/PG`,
      params: { ...baseFields, SecureHash: secureHash },
    };
  }

  /**
   * MLT puts our reference at top-level `RequestId`. Previously the shared
   * callback use-case read this field directly, which silently broke for any
   * provider that names it differently — it now asks each adapter instead.
   */
  extractRequestId(context: GatewayCallbackContext): string | null {
    const requestId = (context.payload as Record<string, unknown>).RequestId;
    return typeof requestId === 'string' && requestId.length > 0
      ? requestId
      : null;
  }

  async verifyResult(
    context: GatewayCallbackContext,
    credentials: GatewayCredentials,
  ): Promise<GatewayResultVerification> {
    // MLT signs specific FIELDS (SecureHash over SignatureFields), not the raw
    // body, so the parsed payload is all this adapter needs.
    const fields = context.payload as Record<string, string | undefined>;
    const signatureFieldsCsv = fields.SignatureFields;
    const providedHash = fields.SecureHash;

    if (!signatureFieldsCsv || !providedHash) {
      return {
        signatureValid: false,
        status: mapMltCardStatus('ERROR'),
        refs: {},
        message: 'Missing SignatureFields or SecureHash in callback payload',
      };
    }

    const signatureValid = this.secureHashService.verify(
      fields,
      signatureFieldsCsv,
      credentials.SECRET_KEY ?? '',
      providedHash,
    );

    if (!signatureValid) {
      return {
        signatureValid: false,
        status: mapMltCardStatus('ERROR'),
        refs: {
          ...(fields.RequestId !== undefined && {
            requestId: fields.RequestId,
          }),
          ...(fields.ReferenceNumber !== undefined && {
            referenceNumber: fields.ReferenceNumber,
          }),
        },
        message: 'SecureHash validation failed',
      };
    }

    const refs: Partial<ProviderRefs> = {
      ...(fields.RequestId !== undefined && { requestId: fields.RequestId }),
      ...(fields.ReferenceNumber !== undefined && {
        referenceNumber: fields.ReferenceNumber,
      }),
      ...(fields.ChannelReferenceNumber && {
        providerRef: fields.ChannelReferenceNumber,
      }),
    };

    return {
      signatureValid: true,
      status: mapMltCardStatus(fields.TransactionStatus ?? 'ERROR'),
      refs,
      ...(fields.ReasonCode !== undefined && { reasonCode: fields.ReasonCode }),
      ...(fields.Message !== undefined && { message: fields.Message }),
    };
  }

  async queryStatus(
    _refs: ProviderRefs,
    _credentials: GatewayCredentials,
  ): Promise<GatewayStatusQueryResult> {
    // MLT's spec (Section 7) states a Transaction Status API is only
    // available if separately enabled per merchant, with details provided
    // outside this document. Until that's confirmed and documented, this
    // must fail loudly rather than silently pretend to reconcile.
    throw new Error(
      'MLT transaction status query is not yet available — requires the separate Transaction Status API details from MLT, not documented in the current integration spec',
    );
  }

  callbackAck(): { status: number; body: string; contentType: string } {
    // Per backend.md's capability matrix: MLT expects hash validation
    // followed by a plain 200 — no special body content required. The body is
    // the bare string `OK`, so it must NOT be labelled application/json.
    return { status: 200, body: 'OK', contentType: 'text/plain' };
  }
}
