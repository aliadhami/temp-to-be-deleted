import { CardProviderConflictError } from '../../../domain/card-provider-conflict.error';
import { CardProviderKey } from '../../../domain/card-provider-key.enum';
import { HYPERCARD_SUCCESS_CODE, HyperCardEnvelope } from './hypercard.types';

/** Stands in for their `code` when the response carried no parseable envelope at all. */
const UNKNOWN_CODE = 'UNKNOWN';

/**
 * The codes meaning "the request is well-formed, but the current state forbids
 * it" — what Axys says with an HTTP 409. HyperCard sends all of these with
 * HTTP 200, so nothing keyed on a status code could recognise them.
 */
const CONFLICT_CODES = new Set<string>([
  'A0005', // Duplicated request
  'A0006', // balance is insufficient
  'A0008', // incomplete application for the same type of card
  'A0009', // Only one card of this type can be applied for
  'A0010', // This card does not support recharging
  // "Card application not currently supported".
  'A0011',
  'A0014', // a currency purchase request is already being processed
  'A0016', // this card type has reached its issuance limit
  'A0017', // Email Duplicate
  'A0018', // Phone number Duplicate
  'A1002', // This card number has been linked to others
  'A1005', // bound successfully and cannot be unbound
]);

/**
 * Carries HyperCard's own `code` and `msg` so callers can distinguish specific
 * failures rather than pattern-matching a message string. Mirrors `AxysApiError`.
 */
export class HyperCardApiError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HyperCardApiError';
  }
}

/** Rejects anything that is not their documented success code. */
export function assertHyperCardSuccess<T>(
  operation: string,
  status: number,
  body: HyperCardEnvelope<T> | null,
): asserts body is HyperCardEnvelope<T> {
  if (body?.code === HYPERCARD_SUCCESS_CODE) return;

  const code = body?.code ?? UNKNOWN_CODE;
  const message = body?.msg ?? 'No error message returned';
  const detail = `HyperCard ${operation} failed (HTTP ${status}, code=${code}): ${message}`;

  // Translated here rather than at the call site, so a use-case can catch one
  // provider-neutral type. Axys reaches the same domain error from an HTTP 409;
  // these arrive as HTTP 200 with a failure code, which is why the two
  // providers cannot share a status-code test.
  if (CONFLICT_CODES.has(code)) {
    throw new CardProviderConflictError(
      CardProviderKey.HYPERCARD,
      code,
      detail,
      {
        cause: new HyperCardApiError(status, code, detail),
      },
    );
  }

  throw new HyperCardApiError(status, code, detail);
}

/**
 * The success path for their data-bearing endpoints: assert the code, then
 * require the payload.
 */
export const unwrapHyperCardData = <T>(
  operation: string,
  status: number,
  body: HyperCardEnvelope<T> | null,
): T => {
  // An assertion signature, so `body` is non-null from here on.
  assertHyperCardSuccess(operation, status, body);

  const data = body.data;
  if (data === undefined || data === null) {
    throw new HyperCardApiError(
      status,
      body.code,
      `HyperCard ${operation} succeeded but returned no data`,
    );
  }

  return data;
};
