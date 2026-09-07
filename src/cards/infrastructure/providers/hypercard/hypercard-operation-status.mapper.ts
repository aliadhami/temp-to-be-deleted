import { Logger } from '@nestjs/common';
import { CardOperationOutcome } from '../../../domain/card-issuer.port';
import { normaliseHyperCardInteger } from './hypercard-coercion.util';
import { HyperCardOperationStatus as Code } from './hypercard.types';

const logger = new Logger('HyperCardOperationStatusMapper');

/**
 * Every outcome their statuses can produce — the union except the not-held arm,
 * which they cannot express through a code at all.
 */
export type HyperCardOperationOutcomeState = Exclude<
  CardOperationOutcome['state'],
  'UNKNOWN_REFERENCE'
>;

/** Their "Card Operation result" statuses, mapped onto the outcome states. */
const STATE_BY_CODE: Record<number, HyperCardOperationOutcomeState> = {
  [Code.IN_OPERATION]: 'PENDING',
  [Code.THIRD_PARTY_SUCCESS]: 'APPLIED',
  // Terminal, which is an **inference**: their list has no finality column and
  // names no state after failure.
  [Code.FAIL]: 'FAILED',
  [Code.PENDING_PAYMENT]: 'PENDING',
  [Code.WAITING_FOR_THIRD_PARTY]: 'PENDING',
};

/**
 * Reads one of their operation status codes, from either form. Null for
 * anything unrecognised, the caller then leaving the operation alone.
 *
 * **Takes the code, never a payload**, so their push event — same field, same
 * five values, typed a string there — reads it through this one mapper.
 */
export const mapHyperCardOperationStatus = (
  raw: unknown,
): HyperCardOperationOutcomeState | null => {
  const code = normaliseHyperCardInteger(raw);
  const state = code === null ? undefined : STATE_BY_CODE[code];

  if (state === undefined) {
    // Warned, never thrown: one unfamiliar code must not take down a pass
    // examining a batch.
    logger.warn(
      `HyperCard returned operation status "${String(
        raw,
      )}", which is not in their operation status list — leaving the operation to be asked about again`,
    );
    return null;
  }

  if (code === Code.PENDING_PAYMENT) {
    // Pending for the write, distinct in the log: a freeze should cost nothing,
    // so this value on one is a surprise. Fires per look — a pure mapper has no
    // memory, and the row does not store their code.
    logger.warn(
      'HyperCard reports an operation as awaiting payment — treated as pending, but no operation this integration requests is expected to cost anything',
    );
  }

  return state;
};
