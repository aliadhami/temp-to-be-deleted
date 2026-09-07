import { GatewayCredentials } from './gateway-credentials.model';
import { PayoutStatus } from './payout-status.enum';

export interface PayoutRequest {
  orderNum: string;
  /** Decimal string, e.g. "250.00" */
  amount: string;
  currency: string;
  beneficiaryName: string;
  beneficiaryAccount: string;
  bankCode?: string;
}

export interface PayoutResult {
  status: PayoutStatus;
  providerRef?: string;
  message?: string;
}

export interface PayoutGatewayPort {
  payout(
    request: PayoutRequest,
    credentials: GatewayCredentials,
  ): Promise<PayoutResult>;

  verifyPayoutResult(
    payload: Readonly<Record<string, unknown>>,
    credentials: GatewayCredentials,
  ): Promise<PayoutResult & { signatureValid: boolean }>;
}
