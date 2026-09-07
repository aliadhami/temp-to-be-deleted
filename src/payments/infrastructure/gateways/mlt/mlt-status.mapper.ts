import { PaymentStatus } from '../../../domain/payment-status.enum';
import { MltCardTransactionStatus } from './mlt.types';

const MLT_CARD_STATUS_MAP: Record<MltCardTransactionStatus, PaymentStatus> = {
  PAID: PaymentStatus.PAID,
  REJECT: PaymentStatus.REJECTED,
  FAILED: PaymentStatus.FAILED,
  CANCEL: PaymentStatus.CANCELLED,
  ERROR: PaymentStatus.ERROR,
};

/**
 * Maps MLT's card-payment TransactionStatus to our canonical PaymentStatus.
 * Per MLT spec Section 5: any status/reason code not explicitly listed
 * must be treated as unsuccessful until verified with MLT support — so an
 * unrecognized value fails safe to ERROR rather than being silently
 * accepted as some other state.
 */
export const mapMltCardStatus = (mltStatus: string): PaymentStatus => {
  const mapped = MLT_CARD_STATUS_MAP[mltStatus as MltCardTransactionStatus];
  return mapped ?? PaymentStatus.ERROR;
};
