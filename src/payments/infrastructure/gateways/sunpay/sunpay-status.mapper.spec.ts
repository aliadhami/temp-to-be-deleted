import { PaymentStatus } from '../../../domain/payment-status.enum';
import {
  isSunPayAmountSufficient,
  mapSunPayOrderStatus,
  mapSunPayWebhookStatus,
} from './sunpay-status.mapper';

describe('sunpay-status.mapper', () => {
  describe('mapSunPayOrderStatus (query endpoint: PENDING | SUCCESS | CANCEL)', () => {
    it.each([
      ['PENDING', PaymentStatus.PENDING],
      ['SUCCESS', PaymentStatus.PAID],
      ['CANCEL', PaymentStatus.CANCELLED],
    ])('maps %s → %s', (input, expected) => {
      expect(mapSunPayOrderStatus(input)).toBe(expected);
    });

    it('is case- and whitespace-insensitive', () => {
      expect(mapSunPayOrderStatus(' success ')).toBe(PaymentStatus.PAID);
      expect(mapSunPayOrderStatus('Pending')).toBe(PaymentStatus.PENDING);
    });

    it('maps anything unrecognised to ERROR, never to PAID', () => {
      for (const unknown of [
        '',
        'NO_PAY',
        'PAY_CANCEL',
        'PAY_ERROR',
        'COMPLETED',
        'PAID',
        'weird',
      ]) {
        expect(mapSunPayOrderStatus(unknown)).toBe(PaymentStatus.ERROR);
      }
    });

    it('handles null/undefined without throwing', () => {
      expect(mapSunPayOrderStatus(null)).toBe(PaymentStatus.ERROR);
      expect(mapSunPayOrderStatus(undefined)).toBe(PaymentStatus.ERROR);
    });
  });

  describe('mapSunPayWebhookStatus (webhook: SUCCESS | FAIL)', () => {
    it.each([
      ['SUCCESS', PaymentStatus.PAID],
      ['FAIL', PaymentStatus.FAILED],
    ])('maps %s → %s', (input, expected) => {
      expect(mapSunPayWebhookStatus(input)).toBe(expected);
    });

    it('does NOT accept query-endpoint vocabulary — the two sets differ', () => {
      // "PENDING" and "CANCEL" are valid order_status values but are not
      // documented biz_status values, so they must not silently pass through.
      expect(mapSunPayWebhookStatus('PENDING')).toBe(PaymentStatus.ERROR);
      expect(mapSunPayWebhookStatus('CANCEL')).toBe(PaymentStatus.ERROR);
    });

    it('maps anything unrecognised to ERROR', () => {
      for (const unknown of ['', 'FAILED', 'NO_PAY', 'PAY_ERROR', 'ok']) {
        expect(mapSunPayWebhookStatus(unknown)).toBe(PaymentStatus.ERROR);
      }
    });
  });

  describe('isSunPayAmountSufficient', () => {
    it('accepts an exact match', () => {
      expect(isSunPayAmountSufficient('20.00', '20.00')).toBe(true);
      expect(isSunPayAmountSufficient('20', '20.000')).toBe(true);
    });

    it('accepts an overpayment', () => {
      expect(isSunPayAmountSufficient('20.00', '20.01')).toBe(true);
      expect(isSunPayAmountSufficient('20', '100')).toBe(true);
    });

    it('rejects an underpayment that a 2-decimal column would round away', () => {
      // The whole point: 19.999999 must NOT be treated as 20.00.
      expect(isSunPayAmountSufficient('20.00', '19.999999')).toBe(false);
      expect(isSunPayAmountSufficient('20.00', '19.995')).toBe(false);
    });

    it('rejects tiny underpayments at full crypto precision', () => {
      expect(
        isSunPayAmountSufficient(
          '0.000000010000000000',
          '0.000000009999999999',
        ),
      ).toBe(false);
      expect(
        isSunPayAmountSufficient(
          '0.000000010000000000',
          '0.000000010000000000',
        ),
      ).toBe(true);
    });

    it('rejects unparseable or over-precise input rather than guessing', () => {
      expect(isSunPayAmountSufficient('20.00', '')).toBe(false);
      expect(isSunPayAmountSufficient('20.00', 'abc')).toBe(false);
      expect(isSunPayAmountSufficient('20.00', '1e2')).toBe(false);
      // 19 decimal places exceeds our 18-place scale — refuse rather than truncate.
      expect(isSunPayAmountSufficient('1.0', '1.0000000000000000001')).toBe(
        false,
      );
    });

    it('does not lose precision on large values', () => {
      expect(
        isSunPayAmountSufficient('9999999999999.99', '9999999999999.99'),
      ).toBe(true);
      expect(
        isSunPayAmountSufficient('9999999999999.99', '9999999999999.98'),
      ).toBe(false);
    });
  });
});
