import { Logger } from '@nestjs/common';
import { CardDepositOutcome } from '../../../domain/card-issuer.port';
import { normaliseHyperCardInteger } from './hypercard-coercion.util';
import { HyperCardRechargeStatus as Code } from './hypercard.types';

const logger = new Logger('HyperCardRechargeStatusMapper');

/**
 * Every outcome their recharge statuses can produce — the whole union except
 * the arm meaning "they do not hold this reference", which is a lookup that
 * found nothing rather than a status they report.
 */
export type HyperCardRechargeOutcomeState = Exclude<
  CardDepositOutcome['state'],
  'UNKNOWN_REFERENCE'
>;

/**
 * Their "Recharge status" appendix, mapped onto the outcome states the port
 * publishes. Their own "is final status" column is what makes this worth
 * stating.
 */
const STATE_BY_CODE: Record<number, HyperCardRechargeOutcomeState> = {
  [Code.PENDING]: 'PENDING',
  [Code.SUCCESS]: 'SETTLED',
  [Code.FAIL]: 'FAILED',
  [Code.TO_BE_REFUND]: 'REFUND_PENDING',
  [Code.REFUNDED]: 'REFUNDED',
};

/**
 * Reads one of their recharge status codes, from either form. Null for
 * anything unrecognised, and the caller keeps the deposit alive rather than
 * guessing.
 */
export const mapHyperCardRechargeStatus = (
  raw: unknown,
): HyperCardRechargeOutcomeState | null => {
  const code = normaliseHyperCardInteger(raw);
  const state = code === null ? undefined : STATE_BY_CODE[code];

  if (state === undefined) {
    // Warned rather than thrown: one unfamiliar code must not take down a pass
    // that is examining a batch, and the row it describes is left exactly as it
    // was for the next one.
    logger.warn(
      `HyperCard returned recharge status "${String(
        raw,
      )}", which is not in their recharge-status appendix — leaving the deposit to be asked about again`,
    );
    return null;
  }

  return state;
};
