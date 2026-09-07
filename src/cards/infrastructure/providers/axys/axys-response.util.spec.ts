import { CardProviderConflictError } from '../../../domain/card-provider-conflict.error';
import { CardProviderKey } from '../../../domain/card-provider-key.enum';
import { AxysApiError, unwrapAxysData } from './axys-response.util';
import { AxysEnvelope } from './axys.types';

describe('unwrapAxysData', () => {
  const failure = (code: string, message: string): AxysEnvelope<never> => ({
    success: false,
    error: { code, message },
    requestId: 'req-1',
    timestamp: '2026-01-01T00:00:00Z',
  });

  it('returns the payload on success', () => {
    const body: AxysEnvelope<{ id: string }> = {
      success: true,
      data: { id: 'acct-1' },
      requestId: 'req-1',
      timestamp: '2026-01-01T00:00:00Z',
    };

    expect(unwrapAxysData('account creation', 200, body)).toEqual({
      id: 'acct-1',
    });
  });

  it('raises a provider-neutral conflict on a 409', () => {
    // Axys signals "the card is not in a state that allows this" with a 409.
    // Use-cases catch the domain type, so they no longer import an Axys class.
    expect.assertions(4);
    try {
      unwrapAxysData(
        'card status update',
        409,
        failure('INVALID_STATE_TRANSITION', 'bad state'),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(CardProviderConflictError);
      const conflict = error as CardProviderConflictError;
      expect(conflict.providerKey).toBe(CardProviderKey.AXYS);
      expect(conflict.providerCode).toBe('INVALID_STATE_TRANSITION');
      // The original is preserved for logging and support.
      expect(conflict.cause).toBeInstanceOf(AxysApiError);
    }
  });

  it('leaves any other status as a plain AxysApiError', () => {
    expect(() =>
      unwrapAxysData('account creation', 500, failure('INTERNAL', 'boom')),
    ).toThrow(AxysApiError);
    expect(() =>
      unwrapAxysData('account creation', 500, failure('INTERNAL', 'boom')),
    ).not.toThrow(CardProviderConflictError);
  });

  it('throws with an UNKNOWN code when no envelope could be parsed', () => {
    expect(() => unwrapAxysData('account creation', 502, null)).toThrow(
      /code=UNKNOWN/,
    );
  });
});
