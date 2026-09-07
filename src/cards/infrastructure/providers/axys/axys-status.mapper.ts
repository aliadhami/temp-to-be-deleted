import { CardStatus } from '../../../domain/card-status.enum';
import { CardholderStatus } from '../../../domain/cardholder-status.enum';

const CARDHOLDER_STATUS_MAP: Record<string, CardholderStatus> = {
  draft: CardholderStatus.DRAFT,
  pending: CardholderStatus.PENDING,
  under_review: CardholderStatus.UNDER_REVIEW,
  approved: CardholderStatus.APPROVED,
  compliance_decline: CardholderStatus.COMPLIANCE_DECLINE,
  admin_decline: CardholderStatus.ADMIN_DECLINE,
  error: CardholderStatus.ERROR,
  suspended: CardholderStatus.SUSPENDED,
  offboarded: CardholderStatus.OFFBOARDED,
};

/** Fail-safe default to ERROR for any status Axys returns that we don't recognize. */
export const mapAxysCardholderStatus = (raw: string): CardholderStatus =>
  CARDHOLDER_STATUS_MAP[raw] ?? CardholderStatus.ERROR;

const CARD_STATUS_MAP: Record<string, CardStatus> = {
  not_activated: CardStatus.NOT_ACTIVATED,
  active: CardStatus.ACTIVE,
  on_hold: CardStatus.ON_HOLD,
  closed: CardStatus.CLOSED,
};

export const mapAxysCardStatus = (raw: string): CardStatus =>
  CARD_STATUS_MAP[raw] ?? CardStatus.NOT_ACTIVATED;
