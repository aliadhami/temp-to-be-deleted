import { PaymentStatus } from '../../../domain/payment-status.enum';
import { mapMltCardStatus } from './mlt-status.mapper';

describe('mapMltCardStatus', () => {
  it.each([
    ['PAID', PaymentStatus.PAID],
    ['REJECT', PaymentStatus.REJECTED],
    ['FAILED', PaymentStatus.FAILED],
    ['CANCEL', PaymentStatus.CANCELLED],
    ['ERROR', PaymentStatus.ERROR],
  ])('maps MLT status "%s" to %s', (mltStatus, expected) => {
    expect(mapMltCardStatus(mltStatus)).toBe(expected);
  });

  it('fails safe to ERROR for an unrecognized status, per spec Section 5', () => {
    expect(mapMltCardStatus('SOME_UNDOCUMENTED_STATUS')).toBe(
      PaymentStatus.ERROR,
    );
  });

  it('fails safe to ERROR for an empty string', () => {
    expect(mapMltCardStatus('')).toBe(PaymentStatus.ERROR);
  });
});
