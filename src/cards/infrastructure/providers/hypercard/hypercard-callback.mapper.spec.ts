import { Logger } from '@nestjs/common';
import { CardStatus } from '../../../domain/card-status.enum';
import {
  buildHyperCardDeliveryKey,
  mapHyperCardCallbackEvent,
  readHyperCardCallbackLabel,
} from './hypercard-callback.mapper';
import { HyperCardCardApplicationStatus } from './hypercard.types';

describe('mapHyperCardCallbackEvent', () => {
  const publicId = '48d27417-47a4-4936-9361-739208a1b2c3';
  const tradeNumber = publicId.replace(/-/g, '');

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('a card application outcome', () => {
    it('carries the reference back as the public id it was derived from', () => {
      expect(
        mapHyperCardCallbackEvent({
          notify_type: 'OPEN_CARD',
          mc_trade_no: tradeNumber,
          result: '1',
        } as Record<string, unknown>),
      ).toEqual({ kind: 'APPLICATION', reference: publicId });
    });

    it('reads no outcome out of the payload', () => {
      // Their result flag is right there and is deliberately not read: a
      // callback says to ask, and their application-result lookup answers.
      const rejected = mapHyperCardCallbackEvent({
        notify_type: 'OPEN_CARD',
        mc_trade_no: tradeNumber,
        result: '2',
      } as Record<string, unknown>);

      expect(rejected).toEqual({ kind: 'APPLICATION', reference: publicId });
    });

    it('ignores one carrying no reference of ours', () => {
      // Their table marks the field optional — "if your Card Application have
      // mc_trade_no, then there is this field" — and every application sent
      // from here carries one, so its absence means the card is not ours.
      expect(
        mapHyperCardCallbackEvent({
          notify_type: 'OPEN_CARD',
          result: '1',
        } as Record<string, unknown>),
      ).toEqual({ kind: 'UNHANDLED', label: 'OPEN_CARD' });
    });

    it('ignores one whose reference is not the wire form', () => {
      expect(
        mapHyperCardCallbackEvent({
          notify_type: 'OPEN_CARD',
          mc_trade_no: 'not-one-of-ours',
        } as Record<string, unknown>),
      ).toEqual({ kind: 'UNHANDLED', label: 'OPEN_CARD' });
    });
  });

  describe('a deposit outcome', () => {
    it('carries the reference back', () => {
      expect(
        mapHyperCardCallbackEvent({
          notify_type: 'RECHARGE',
          card_id: '00003454323400000028888',
          mc_trade_no: tradeNumber,
          result: 1,
        } as Record<string, unknown>),
      ).toEqual({ kind: 'DEPOSIT', reference: publicId });
    });

    it('ignores one carrying no reference of ours', () => {
      expect(
        mapHyperCardCallbackEvent({
          notify_type: 'RECHARGE',
          card_id: '00003454323400000028888',
        } as Record<string, unknown>),
      ).toEqual({ kind: 'UNHANDLED', label: 'RECHARGE' });
    });
  });

  describe('a lifecycle operation outcome', () => {
    it('takes its reference from their operation field, not the trade number', () => {
      expect(
        mapHyperCardCallbackEvent({
          notify_type: 'OPERATION',
          request_number: tradeNumber,
          operate_status: '1',
          card_id: '00003454323400000028888',
        } as Record<string, unknown>),
      ).toEqual({ kind: 'OPERATION', reference: publicId });
    });

    it('reads no outcome out of the payload', () => {
      // The one callback of theirs carrying a complete outcome, and it is
      // still not written: one writer per stored fact, and their operation
      // result lookup is it.
      const failed = mapHyperCardCallbackEvent({
        notify_type: 'OPERATION',
        request_number: tradeNumber,
        operate_status: '2',
      } as Record<string, unknown>);

      expect(failed).toEqual({ kind: 'OPERATION', reference: publicId });
    });
  });

  describe('a card status change', () => {
    it('maps their code to a card status', () => {
      expect(
        mapHyperCardCallbackEvent({
          notify_type: 'CARD_STATUS_CHANGE',
          card_id: '6232931889900031321',
          old_status: 9,
          new_status: HyperCardCardApplicationStatus.ACTIVE_FREEZE,
        } as Record<string, unknown>),
      ).toEqual({
        kind: 'CARD_STATUS',
        providerCardId: '6232931889900031321',
        status: CardStatus.ON_HOLD,
      });
    });

    it('reads the freeze their API cannot lift the same way', () => {
      // The state nothing else here would ever notice: no pass re-reads a card
      // that has reached active.
      expect(
        mapHyperCardCallbackEvent({
          notify_type: 'CARD_STATUS_CHANGE',
          card_id: '6232931889900031321',
          new_status: HyperCardCardApplicationStatus.PASSIVE_FREEZE,
        } as Record<string, unknown>),
      ).toMatchObject({ status: CardStatus.ON_HOLD });
    });

    it('accepts their code as a string as readily as a number', () => {
      expect(
        mapHyperCardCallbackEvent({
          notify_type: 'CARD_STATUS_CHANGE',
          card_id: '6232931889900031321',
          new_status: String(HyperCardCardApplicationStatus.OPENING_ACTIVATED),
        } as Record<string, unknown>),
      ).toMatchObject({ status: CardStatus.ACTIVE });
    });

    it('ignores their previous status entirely', () => {
      // Trusting it would refuse a change whenever their view of the previous
      // state and ours disagree — which is the case a status callback exists
      // to repair.
      const withNonsensePrevious = mapHyperCardCallbackEvent({
        notify_type: 'CARD_STATUS_CHANGE',
        card_id: '6232931889900031321',
        old_status: 999,
        new_status: HyperCardCardApplicationStatus.OPENING_ACTIVATED,
      } as Record<string, unknown>);

      expect(withNonsensePrevious).toEqual({
        kind: 'CARD_STATUS',
        providerCardId: '6232931889900031321',
        status: CardStatus.ACTIVE,
      });
    });

    it('ignores a code their appendix does not carry', () => {
      // The degrading mapper would read this as not-activated, which on this
      // path would move a live card backwards on a value nothing can read.
      expect(
        mapHyperCardCallbackEvent({
          notify_type: 'CARD_STATUS_CHANGE',
          card_id: '6232931889900031321',
          new_status: 777,
        } as Record<string, unknown>),
      ).toEqual({ kind: 'UNHANDLED', label: 'CARD_STATUS_CHANGE' });
    });

    it('ignores one naming no card', () => {
      expect(
        mapHyperCardCallbackEvent({
          notify_type: 'CARD_STATUS_CHANGE',
          new_status: HyperCardCardApplicationStatus.ACTIVE_FREEZE,
        } as Record<string, unknown>),
      ).toEqual({ kind: 'UNHANDLED', label: 'CARD_STATUS_CHANGE' });
    });
  });

  it('refreshes the whole catalogue on a product change', () => {
    // Their field names one product and their card-config endpoint is a list
    // with no single-product read, so there is nothing narrower to ask for.
    expect(
      mapHyperCardCallbackEvent({
        notify_type: 'CARD_CONFIG_CHANGE',
        card_type_id: '40000002',
      } as Record<string, unknown>),
    ).toEqual({ kind: 'PRODUCT_CATALOGUE' });
  });

  it('ignores a type published since this mapper was written', () => {
    // Their page says new event types arrive. This arm is the difference
    // between ignoring one and failing on it for the length of their retries.
    expect(
      mapHyperCardCallbackEvent({
        notify_type: 'SOMETHING_NEW',
      } as Record<string, unknown>),
    ).toEqual({ kind: 'UNHANDLED', label: 'SOMETHING_NEW' });
  });

  it('ignores a body naming no event at all', () => {
    expect(mapHyperCardCallbackEvent({})).toEqual({
      kind: 'UNHANDLED',
      label: null,
    });
  });
});

describe('readHyperCardCallbackLabel', () => {
  it('reads their empty value as no label', () => {
    // Their empty value is the empty string rather than a missing key.
    expect(readHyperCardCallbackLabel({ notify_type: '' })).toBeNull();
    expect(readHyperCardCallbackLabel({})).toBeNull();
  });

  it('strips control characters', () => {
    // This value is read before anything is authenticated and reaches a log
    // line, so a newline in it would forge a record.
    expect(
      readHyperCardCallbackLabel({ notify_type: 'OPEN\nCARD\r\n[fake] entry' }),
    ).toBe('OPENCARD[fake] entry');
  });

  it('caps a label far longer than any of theirs', () => {
    const label = readHyperCardCallbackLabel({ notify_type: 'X'.repeat(5000) });

    expect(label).toHaveLength(64);
  });

  it('reads a label that is nothing but control characters as absent', () => {
    expect(
      readHyperCardCallbackLabel({ notify_type: '\u0000\u0007' }),
    ).toBeNull();
  });
});

describe('buildHyperCardDeliveryKey', () => {
  const body = {
    notify_type: 'CARD_STATUS_CHANGE',
    card_id: '6232931889900031321',
    old_status: 9,
    new_status: 10,
  };

  it('is a sha-256 hex digest', () => {
    expect(buildHyperCardDeliveryKey(body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on the order the fields arrived in', () => {
    // The canonical string sorts by name, so a re-ordered redelivery of the
    // same event is still the same delivery.
    expect(
      buildHyperCardDeliveryKey({
        new_status: 10,
        card_id: '6232931889900031321',
        notify_type: 'CARD_STATUS_CHANGE',
        old_status: 9,
      }),
    ).toBe(buildHyperCardDeliveryKey(body));
  });

  it('changes when any field changes', () => {
    expect(buildHyperCardDeliveryKey({ ...body, new_status: 18 })).not.toBe(
      buildHyperCardDeliveryKey(body),
    );
  });

  it('gives two structurally different bodies different keys', () => {
    // A field value may contain the separators a joined `name=value` form uses,
    // so a digest built from one is not injective: these two rendered
    // identically under the signing canonical string, and the second delivery
    // would have been discarded as a retry of the first.
    const split = { card_id: '1', notify_type: 'CONSUME', tx_id: '9' };
    const joined = { card_id: '1', notify_type: 'CONSUME&tx_id=9' };

    expect(buildHyperCardDeliveryKey(joined)).not.toBe(
      buildHyperCardDeliveryKey(split),
    );
  });

  it('separates a nested value from a flattened one', () => {
    expect(buildHyperCardDeliveryKey({ a: { b: 'c' } })).not.toBe(
      buildHyperCardDeliveryKey({ 'a.b': 'c' }),
    );
  });

  it('gives two distinct events with identical bodies one key', () => {
    // The known cost of keying on content, recorded rather than worked around:
    // an application rejected twice on one reference differs in no field. It
    // loses the promptness of the second outcome and not the outcome, because
    // the handler asks the issuer what is true now.
    const rejection = {
      notify_type: 'OPEN_CARD',
      mc_trade_no: '48d2741747a449361739208a1b2c3d4e',
      result: '2',
    };

    expect(buildHyperCardDeliveryKey({ ...rejection })).toBe(
      buildHyperCardDeliveryKey({ ...rejection }),
    );
  });
});
