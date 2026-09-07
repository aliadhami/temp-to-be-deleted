import { GatewayCapability } from './gateway-capability.enum';
import { PaymentGatewayPort } from './payment-gateway.port';
import { PayoutGatewayPort } from './payout-gateway.port';
import { RefundCapablePort } from './refund-capable.port';

export const supportsPayout = (
  gateway: PaymentGatewayPort,
): gateway is PaymentGatewayPort & PayoutGatewayPort =>
  gateway.capabilities.has(GatewayCapability.PAYOUT);

export const supportsRefund = (
  gateway: PaymentGatewayPort,
): gateway is PaymentGatewayPort & RefundCapablePort =>
  gateway.capabilities.has(GatewayCapability.REFUND);
