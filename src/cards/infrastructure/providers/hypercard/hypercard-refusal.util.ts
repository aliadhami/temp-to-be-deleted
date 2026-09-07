import { CardProviderConflictError } from '../../../domain/card-provider-conflict.error';
import { CardProviderKey } from '../../../domain/card-provider-key.enum';
import { HyperCardApiError } from './hypercard-response.util';

/**
 * Whether an error is a refusal on the endpoint that raised it. **Each caller
 * passes the codes it can account for and there is no shared list** — their
 * codes mean different things on different endpoints.
 */
export const isHyperCardRefusal = (
  error: unknown,
  codes: readonly string[],
): error is HyperCardApiError =>
  error instanceof HyperCardApiError && codes.includes(error.code);

/** Their refusal as the one error type a use-case outside this folder can catch. */
export const toHyperCardConflict = (
  error: HyperCardApiError,
): CardProviderConflictError =>
  new CardProviderConflictError(
    CardProviderKey.HYPERCARD,
    error.code,
    error.message,
    { cause: error },
  );
