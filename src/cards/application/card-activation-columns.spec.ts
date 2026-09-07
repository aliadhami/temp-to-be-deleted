import { CardActivationStatus } from '../domain/card-activation-status.enum';
import { CardStatus } from '../domain/card-status.enum';
import { activationColumnsFor } from './card-activation-columns';

describe('activationColumnsFor', () => {
  it('clears every activation column once the card is usable', () => {
    // Whatever else the answer said: a usable card has no activation
    // outstanding, and this is the only thing that clears one.
    expect(
      activationColumnsFor(
        {
          status: CardStatus.ACTIVE,
          activation: CardActivationStatus.PENDING,
        },
        'E001',
        'the photograph is blurred',
      ),
    ).toEqual({
      activationStatus: null,
      activationReasonCode: null,
      activationReason: null,
    });
  });

  it('keeps the issuer’s own code and words for a refused activation', () => {
    expect(
      activationColumnsFor(
        {
          status: CardStatus.NOT_ACTIVATED,
          activation: CardActivationStatus.FAILED,
        },
        'E001',
        'the photograph is blurred',
      ),
    ).toEqual({
      activationStatus: CardActivationStatus.FAILED,
      activationReasonCode: 'E001',
      activationReason: 'the photograph is blurred',
    });
  });

  it('stamps an activation in flight and carries no reason with it', () => {
    expect(
      activationColumnsFor(
        {
          status: CardStatus.NOT_ACTIVATED,
          activation: CardActivationStatus.PENDING,
        },
        'E001',
        'from an earlier attempt',
      ),
    ).toEqual({
      activationStatus: CardActivationStatus.PENDING,
      activationReasonCode: null,
      activationReason: null,
    });
  });

  it('writes nothing at all when the issuer said nothing about an activation', () => {
    // Null is "no information", never "nothing is pending" — an issuer reports
    // a card's pre-activation state for a while after accepting one, so
    // clearing a stored PENDING here would clear it inside its own window.
    expect(
      activationColumnsFor({ status: CardStatus.NOT_ACTIVATED }),
    ).toBeNull();
  });

  it('writes nothing on a card the issuer moved without mentioning activation', () => {
    expect(activationColumnsFor({ status: CardStatus.ON_HOLD })).toBeNull();
  });

  it('needs no reasons from a caller that has none', () => {
    // The status-callback writer knows only the status, and the defaults keep
    // it from having to pass nulls it never read.
    expect(activationColumnsFor({ status: CardStatus.ACTIVE })).toEqual({
      activationStatus: null,
      activationReasonCode: null,
      activationReason: null,
    });
  });
});
