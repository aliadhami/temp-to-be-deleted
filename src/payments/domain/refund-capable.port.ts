import { GatewayCredentials } from './gateway-credentials.model';
import { RefundStatus } from './refund-status.enum';

export interface RefundResult {
  status: RefundStatus;
  providerRef?: string;
  message?: string;
}

export interface RefundCapablePort {
  refund(
    providerRef: string,
    /** Decimal string ≤ remaining refundable amount — enforced by the use case */
    amount: string,
    credentials: GatewayCredentials,
  ): Promise<RefundResult>;

  queryRefund(
    refundProviderRef: string,
    credentials: GatewayCredentials,
  ): Promise<RefundResult>;
}
