import { Logger } from '@nestjs/common';
import { CardActivationStatus } from '../../../domain/card-activation-status.enum';
import { CardStatus } from '../../../domain/card-status.enum';
import {
  mapHyperCardActivationStatus,
  mapHyperCardCardStatus,
} from './hypercard-status.mapper';

describe('hypercard-status.mapper', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  /** Jest types `mock.calls` as `any[]`; narrowed once so assertions stay checked. */
  const firstWarning = (): unknown =>
    (warn.mock.calls as unknown as unknown[][])[0]?.[0];

  describe('mapHyperCardCardStatus', () => {
    // Every code their "Card Application Status" appendix defines, in its own
    // order. Their appendix skips 16, 17, 19, 20 and 25-29 — those belong to
    // the unknown branch below, not here.
    it.each<[number, CardStatus]>([
      [0, CardStatus.NOT_ACTIVATED], // Opening - Pre Apply
      [1, CardStatus.NOT_ACTIVATED], // Opening - Pending for payment
      [2, CardStatus.NOT_ACTIVATED], // Opening - Reviewing
      [3, CardStatus.NOT_ACTIVATED], // Opening - Reviewed - Success
      [4, CardStatus.CLOSED], // Opening - Reviewed - Rejected
      [5, CardStatus.CLOSED], // Opening - Refunded
      [6, CardStatus.NOT_ACTIVATED], // Opening - Shipped
      [7, CardStatus.NOT_ACTIVATED], // Opening - Activating
      [8, CardStatus.NOT_ACTIVATED], // Opening - Activation fails
      [9, CardStatus.ACTIVE], // Opening - Activated
      [10, CardStatus.ON_HOLD], // Active Freeze
      [11, CardStatus.NOT_ACTIVATED], // Activation - Reviewing
      [12, CardStatus.NOT_ACTIVATED], // Activation - Reviewed - Rejected
      [13, CardStatus.ACTIVE], // Activation - Reviewed - Success
      [14, CardStatus.CLOSED], // Cancelling Card
      [15, CardStatus.CLOSED], // Cancelled
      [18, CardStatus.ON_HOLD], // Passive Freeze
      [21, CardStatus.CLOSED], // Refund - Reviewing
      [22, CardStatus.CLOSED], // Refund - Reviewed - Rejected
      [23, CardStatus.CLOSED], // Refund - Reviewed - Success
      [24, CardStatus.NOT_ACTIVATED], // Opening - Wait Attachment
      [30, CardStatus.NOT_ACTIVATED], // Wait for recharge
    ])('maps their code %i to %s', (code, expected) => {
      expect(mapHyperCardCardStatus(code)).toBe(expected);
      expect(warn).not.toHaveBeenCalled();
    });

    it('maps the string form identically to the integer form', () => {
      // Their query endpoints type this enum as an integer and their push
      // events as a string; both must land on the same status.
      expect(mapHyperCardCardStatus('9')).toBe(CardStatus.ACTIVE);
      expect(mapHyperCardCardStatus('10')).toBe(CardStatus.ON_HOLD);
      expect(warn).not.toHaveBeenCalled();
    });

    it('falls back to NOT_ACTIVATED and warns on a code their appendix leaves undefined', () => {
      expect(mapHyperCardCardStatus(16)).toBe(CardStatus.NOT_ACTIVATED);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(firstWarning()).toContain('16');
    });

    it('falls back and warns on a value that is not an integer code at all', () => {
      for (const raw of ['', '  ', 'ACTIVE', '9.5', Number.NaN]) {
        expect(mapHyperCardCardStatus(raw)).toBe(CardStatus.NOT_ACTIVATED);
      }
      expect(warn).toHaveBeenCalledTimes(5);
    });
  });

  describe('mapHyperCardActivationStatus', () => {
    // The four codes in their appendix that are about an activation attempt
    // rather than about the card around it.
    it.each<[number, CardActivationStatus]>([
      [7, CardActivationStatus.PENDING], // Opening - Activating
      [8, CardActivationStatus.FAILED], // Opening - Activation fails
      [11, CardActivationStatus.PENDING], // Activation - Reviewing
      [12, CardActivationStatus.FAILED], // Activation - Reviewed - Rejected
    ])('reads their code %i as %s', (code, expected) => {
      expect(mapHyperCardActivationStatus(code)).toBe(expected);
      expect(warn).not.toHaveBeenCalled();
    });

    // The trap this guards: code 3 is what they report for a while *after*
    // accepting an activation, so null here has to mean "they said nothing
    // about it" and never "there is nothing outstanding".
    it.each([0, 1, 2, 3, 4, 5, 6, 9, 10, 13, 14, 15, 18, 21, 22, 23, 24, 30])(
      'reads their code %i as no information',
      (code) => {
        expect(mapHyperCardActivationStatus(code)).toBeNull();
        expect(warn).not.toHaveBeenCalled();
      },
    );

    it('reads the string form identically to the integer form', () => {
      expect(mapHyperCardActivationStatus('7')).toBe(
        CardActivationStatus.PENDING,
      );
      expect(mapHyperCardActivationStatus('12')).toBe(
        CardActivationStatus.FAILED,
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads an unrecognised code as no information, without a second warning', () => {
      // The card-status mapper already warns on these; warning twice for one
      // response would read as two separate faults.
      for (const raw of [16, 'ACTIVE', '']) {
        expect(mapHyperCardActivationStatus(raw)).toBeNull();
      }
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
