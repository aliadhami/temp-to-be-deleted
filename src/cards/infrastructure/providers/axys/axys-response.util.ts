import { CardProviderConflictError } from '../../../domain/card-provider-conflict.error';
import { CardProviderKey } from '../../../domain/card-provider-key.enum';
import { AxysEnvelope } from './axys.types';

/** Carries Axys's own status/code/requestId so callers can distinguish specific failures (e.g. a closed-card 409) from generic errors. */
export class AxysApiError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string,
  ) {
    super(message);
    this.name = 'AxysApiError';
  }
}

export const unwrapAxysData = <T>(
  operation: string,
  status: number,
  body: AxysEnvelope<T> | null,
): T => {
  if (!body?.success || !body.data) {
    const code = body?.error?.code ?? 'UNKNOWN';
    const message = body?.error?.message ?? 'No error message returned';
    const requestId = body?.requestId ?? 'unknown';
    const detail = `Axys ${operation} failed (HTTP ${status}, code=${code}, requestId=${requestId}): ${message}`;

    // Axys signals "the card is not in a state that allows this" with a 409.
    if (status === 409) {
      throw new CardProviderConflictError(CardProviderKey.AXYS, code, detail, {
        cause: new AxysApiError(status, code, detail, requestId),
      });
    }

    throw new AxysApiError(status, code, detail, requestId);
  }
  return body.data;
};
