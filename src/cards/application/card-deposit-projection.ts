import { CardDepositResponseDto } from '../api/dto/card-deposit-response.dto';
import { CardDepositEntity } from '../infrastructure/persistence/card-deposit.entity';

/**
 * The one place a deposit row becomes a response, shared by the request path
 * and both read paths so a field cannot be added to one and forgotten on
 * another.
 */
export const toCardDepositResponse = (
  deposit: CardDepositEntity,
): CardDepositResponseDto => ({
  publicId: deposit.publicId,
  requestId: deposit.requestId,
  amount: deposit.amount,
  currency: deposit.currencyCode,
  status: deposit.status,
  creditedAmount: deposit.creditedAmount,
  reason: deposit.message,
  createdAt: deposit.createdAt,
});
