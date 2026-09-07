import { CardProviderConflictError } from '../../../domain/card-provider-conflict.error';
import { CardProviderKey } from '../../../domain/card-provider-key.enum';
import {
  assertHyperCardSuccess,
  HyperCardApiError,
  unwrapHyperCardData,
} from './hypercard-response.util';
import {
  HyperCardEnvelope,
  HyperCardMerchantBalanceEntry,
} from './hypercard.types';

describe('hypercard-response.util', () => {
  describe('unwrapHyperCardData', () => {
    it('returns the payload on their success code', () => {
      // Their "Balance Inquiry" endpoint's own documented sample response.
      const body: HyperCardEnvelope<{ available_balance: string }> = {
        code: '00000',
        msg: 'ok',
        data: { available_balance: '100.00' },
      };

      expect(unwrapHyperCardData('balance inquiry', 200, body)).toEqual({
        available_balance: '100.00',
      });
    });

    it('returns an array payload unchanged', () => {
      // Their "Merchant Balance" endpoint returns `data` as an array, not the
      // object their "API Specification" page declares. Verbatim from their
      // documented sample response.
      const body: HyperCardEnvelope<HyperCardMerchantBalanceEntry[]> = {
        code: '00000',
        msg: 'ok',
        data: [{ amount: '100.00', coin: 'usdt', total_amount: '100.888888' }],
      };

      expect(unwrapHyperCardData('merchant balance', 200, body)).toEqual([
        { amount: '100.00', coin: 'usdt', total_amount: '100.888888' },
      ]);
    });

    it('throws when a success code carries no data', () => {
      // Their "Recharge" endpoint states a card in pre-apply state "will return
      // empty data field on respond" — a success the caller cannot use.
      const body: HyperCardEnvelope<unknown> = { code: '00000', msg: 'ok' };

      expect(() => unwrapHyperCardData('recharge', 200, body)).toThrow(
        HyperCardApiError,
      );
      expect(() => unwrapHyperCardData('recharge', 200, body)).toThrow(
        /succeeded but returned no data/,
      );
    });

    it('preserves their code and message on an error code', () => {
      // Their "Signature error" code, from their response-error-code appendix.
      const body: HyperCardEnvelope<unknown> = {
        code: 'A0001',
        msg: 'Signature error',
      };

      expect.assertions(4);
      try {
        unwrapHyperCardData('merchant balance', 200, body);
      } catch (error) {
        expect(error).toBeInstanceOf(HyperCardApiError);
        const apiError = error as HyperCardApiError;
        expect(apiError.code).toBe('A0001');
        expect(apiError.httpStatus).toBe(200);
        expect(apiError.message).toContain('Signature error');
      }
    });

    it('raises a provider-neutral conflict for a state-refusal code', () => {
      // Their "Duplicated request" code. It arrives as HTTP 200, so a use-case
      // keyed on Axys's 409 could never match it — the point of translating
      // here into the shared domain error instead.
      const body: HyperCardEnvelope<unknown> = {
        code: 'A0005',
        msg: 'Duplicated request',
      };

      expect.assertions(4);
      try {
        unwrapHyperCardData('recharge', 200, body);
      } catch (error) {
        expect(error).toBeInstanceOf(CardProviderConflictError);
        const conflict = error as CardProviderConflictError;
        expect(conflict.providerKey).toBe(CardProviderKey.HYPERCARD);
        expect(conflict.providerCode).toBe('A0005');
        expect(conflict.cause).toBeInstanceOf(HyperCardApiError);
      }
    });

    it('leaves a non-state failure as a plain HyperCardApiError', () => {
      // Their "Signature error" code is our bug, not a card-state problem, so
      // it must not be dressed up as a conflict a partner could act on.
      const body: HyperCardEnvelope<unknown> = {
        code: 'A0001',
        msg: 'Signature error',
      };

      expect(() => unwrapHyperCardData('merchant balance', 200, body)).toThrow(
        HyperCardApiError,
      );
      expect(() =>
        unwrapHyperCardData('merchant balance', 200, body),
      ).not.toThrow(CardProviderConflictError);
    });

    it('throws with an UNKNOWN code when no envelope could be parsed', () => {
      // A 401/403/404 off their documented HTTP response codes, or any
      // non-JSON body, reaches the helper as null.
      expect.assertions(2);
      try {
        unwrapHyperCardData('merchant balance', 401, null);
      } catch (error) {
        const apiError = error as HyperCardApiError;
        expect(apiError.code).toBe('UNKNOWN');
        expect(apiError.httpStatus).toBe(401);
      }
    });
  });

  describe('assertHyperCardSuccess', () => {
    it('accepts an acknowledgement-only success with no data', () => {
      // Their "Card operation request" endpoint documents exactly this shape as
      // its success response.
      const body: HyperCardEnvelope<never> = { code: '00000', msg: 'ok' };

      expect(() =>
        assertHyperCardSuccess('card operation request', 200, body),
      ).not.toThrow();
    });

    it('rejects any code other than their success code', () => {
      // Their "Card no existed" code.
      const body: HyperCardEnvelope<never> = {
        code: 'A0004',
        msg: 'Card no existed',
      };

      expect.assertions(2);
      try {
        assertHyperCardSuccess('card operation request', 200, body);
      } catch (error) {
        const apiError = error as HyperCardApiError;
        expect(apiError.code).toBe('A0004');
        expect(apiError.message).toContain('Card no existed');
      }
    });

    it('rejects a null envelope', () => {
      expect(() => assertHyperCardSuccess('activation', 500, null)).toThrow(
        HyperCardApiError,
      );
    });
  });
});
