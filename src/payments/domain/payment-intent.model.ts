import { GatewayKey } from './gateway-key.enum';
import { PaymentMethod } from './payment-method.enum';
import { PaymentStatus } from './payment-status.enum';

export interface PaymentCustomer {
  email?: string;
  name?: string;
  country?: string; // ISO 3166-1 alpha-2
}

export interface ProviderRefs {
  /** Merchant-generated unique id — idempotency key with gatewayKey */
  requestId: string;
  /** Merchant reference shown to finance/support */
  referenceNumber: string;
  /** Provider-side order/transaction ref, known after initiate or callback */
  providerRef?: string;
}

export interface PaymentIntent {
  publicId: string;
  partnerId: string | null;
  /**
   * The partner's external UUID. Preferred over `partnerId` for anything sent
   * to a third party — internal sequential ids shouldn't leave the system.
   */
  partnerPublicId?: string;
  gatewayKey: GatewayKey;
  method: PaymentMethod;
  /** Canonical amount as a decimal string, e.g. "10.00" — never a float */
  amount: string;
  /** ISO 4217, e.g. "AED" */
  currency: string;
  status: PaymentStatus;
  refs: ProviderRefs;
  customer: PaymentCustomer;
  callbackUrl: string;
  /**
   * Blockchain network for crypto gateways (e.g. "TRON"). Absent for fiat.
   * When omitted, a crypto adapter falls back to its configured default chain.
   */
  chainType?: string;
}
