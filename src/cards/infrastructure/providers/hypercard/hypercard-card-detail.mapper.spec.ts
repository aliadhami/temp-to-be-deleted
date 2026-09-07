import { Logger } from '@nestjs/common';
import {
  HyperCardCardDetailError,
  mapHyperCardCardDetail,
} from './hypercard-card-detail.mapper';
import { HyperCardCardDetailData } from './hypercard.types';

/**
 * Their four documented plaintexts, copied from the `encoded_card_detail`
 * description on their "Bank card detail-v2" page.
 */
const THEIR_VIRTUAL_API_PAYLOAD =
  '{"cvv":"123","card_number":"1001022400001101","expire":"04/2025"}';
const THEIR_PHYSICAL_API_PAYLOAD = '{"card_number":"123456789101212"}';
const THEIR_HOSTED_PAGE_PAYLOAD =
  '{"url":"https://www.test.com/card?card?8888888888888888", "password":"888888", "expires_at":"1772712803","expires_in":"3600"}';
const THEIR_EMAIL_PAYLOAD =
  '{"cvv":"please check in email","card_number":"1001022400001101","expire":"please check in email"}';

const responseFor = (
  obtainWay: string | number,
  cardType: string | number,
): HyperCardCardDetailData => ({
  pub_key: 'irrelevant-here — the adapter checks the echo',
  card_id: '30806984524000022826',
  encoded_card_detail: 'irrelevant-here — decryption happens before this',
  card_detail_obtain_way: obtainWay,
  card_type: cardType,
});

describe('mapHyperCardCardDetail', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('their obtain way 0 — through the API', () => {
    it('maps a virtual card to the full set, splitting the full number from the masked one', () => {
      const detail = mapHyperCardCardDetail(
        responseFor(0, 1),
        THEIR_VIRTUAL_API_PAYLOAD,
      ).expose();

      expect(detail).toEqual({
        kind: 'FULL',
        // Their `card_number` is the complete PAN, and the masked form is
        // derived in their own style. One field could not carry both, and a
        // partner reading `maskedPan` must never receive an unmasked number.
        pan: '1001022400001101',
        maskedPan: '100102******1101',
        cvv: '123',
        expiryMonth: 4,
        expiryYear: 2025,
      });
    });

    it('maps a physical card to the number alone', () => {
      // Handling this payload is not implementing physical issuance — no
      // adapter here has built that, and reading a card is not opening one.
      const detail = mapHyperCardCardDetail(
        responseFor(0, 2),
        THEIR_PHYSICAL_API_PAYLOAD,
      ).expose();

      expect(detail).toEqual({
        kind: 'NUMBER_ONLY',
        pan: '123456789101212',
        maskedPan: '123456*****1212',
      });
    });

    it('refuses a card type it cannot place, naming the value', () => {
      // Two payloads differ by exactly this field, so an unfamiliar value
      // leaves no way to tell whether a missing security code is the answer.
      expect(() =>
        mapHyperCardCardDetail(responseFor(0, 9), THEIR_VIRTUAL_API_PAYLOAD),
      ).toThrow(/unrecognised card_type "9"/);
    });
  });

  describe('their obtain way 1 — a hosted page', () => {
    it('maps to a page carrying no card data at all', () => {
      const detail = mapHyperCardCardDetail(
        responseFor(1, 1),
        THEIR_HOSTED_PAGE_PAYLOAD,
      ).expose();

      expect(detail).toEqual({
        kind: 'HOSTED_PAGE',
        url: 'https://www.test.com/card?card?8888888888888888',
        password: '888888',
        // Their absolute timestamp wins over their relative one.
        expiresAt: new Date(1772712803 * 1000).toISOString(),
      });
    });

    it('derives an expiry from their relative form when that is all they sent', () => {
      const before = Date.now();
      const detail = mapHyperCardCardDetail(
        responseFor(1, 1),
        '{"url":"https://www.test.com/card","expires_in":"3600"}',
      ).expose();

      if (detail.kind !== 'HOSTED_PAGE') throw new Error('wrong arm');
      const expiresAt = Date.parse(detail.expiresAt ?? '');
      expect(expiresAt).toBeGreaterThanOrEqual(before + 3599_000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3601_000);
      // Both are optional on their page, so an absent password is ordinary.
      expect(detail.password).toBeUndefined();
    });

    it('reports a page whose expiry it cannot read rather than refusing the read', () => {
      // The URL still works. An expiry we could not parse is not a page we
      // failed to fetch.
      const detail = mapHyperCardCardDetail(
        responseFor(1, 1),
        '{"url":"https://www.test.com/card","expires_at":"not-a-timestamp"}',
      ).expose();

      expect(detail).toEqual({
        kind: 'HOSTED_PAGE',
        url: 'https://www.test.com/card',
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('expiry could not be read'),
      );
    });

    it('refuses a page with no URL', () => {
      expect(() =>
        mapHyperCardCardDetail(responseFor(1, 1), '{"password":"888888"}'),
      ).toThrow(/no "url"/);
    });

    it('does not read the card type, which their page says is irrelevant here', () => {
      // A hosted page carries no card data, so the form factor decides nothing
      // — including for a card type this mapper would otherwise refuse.
      expect(() =>
        mapHyperCardCardDetail(responseFor(1, 99), THEIR_HOSTED_PAGE_PAYLOAD),
      ).not.toThrow();
    });
  });

  describe('their obtain way 2 — the issuer delivers to the cardholder', () => {
    it('never emits their placeholder prose as a security code', () => {
      // The single most load-bearing assertion in this file. Their payload
      // fills `cvv` and `expire` with the literal words "please check in
      // email"; an arm saying "the secrets went to the cardholder" is true, and
      // a `cvv` of that text is a lie typed as a card credential.
      const detail = mapHyperCardCardDetail(
        responseFor(2, 1),
        THEIR_EMAIL_PAYLOAD,
      ).expose();

      expect(detail).toEqual({
        kind: 'CARDHOLDER_DIRECT',
        pan: '1001022400001101',
        maskedPan: '100102******1101',
      });
      expect(JSON.stringify(detail)).not.toContain('please check in email');
    });

    it('does not run the expiry parser over their prose', () => {
      // Parsing `"please check in email"` would refuse a card that is working
      // perfectly. This arm reaches no parser at all.
      expect(() =>
        mapHyperCardCardDetail(responseFor(2, 1), THEIR_EMAIL_PAYLOAD),
      ).not.toThrow();
    });
  });

  describe('values they have not published', () => {
    it('refuses an obtain way it does not recognise, naming the value', () => {
      // Their pages document three. A fourth means we do not know what the
      // bytes just decrypted are, and there is no arm to put them in.
      expect(() =>
        mapHyperCardCardDetail(responseFor(3, 1), THEIR_VIRTUAL_API_PAYLOAD),
      ).toThrow(HyperCardCardDetailError);
      expect(() =>
        mapHyperCardCardDetail(responseFor(3, 1), THEIR_VIRTUAL_API_PAYLOAD),
      ).toThrow(/unrecognised card_detail_obtain_way "3"/);
    });

    it('refuses an expiry that is not their published MM/YYYY form, without echoing it', () => {
      const attempt = (): unknown =>
        mapHyperCardCardDetail(
          responseFor(0, 1),
          '{"cvv":"123","card_number":"1001022400001101","expire":"2025-04"}',
        );

      expect(attempt).toThrow(/not their published MM\/YYYY form/);
      // An expiry is card data, so the refusal names the field and never the
      // value — unlike the obtain way above, which is their own integer.
      expect(attempt).not.toThrow(/2025-04/);
    });

    it('refuses a month outside 1–12 rather than letting it reach a response', () => {
      // A distinct message from the shape refusal above: `13/2025` matches their
      // published form exactly and is still not a date, so telling the reader it
      // is malformed would send them looking at the wrong thing.
      expect(() =>
        mapHyperCardCardDetail(
          responseFor(0, 1),
          '{"cvv":"123","card_number":"1001022400001101","expire":"13/2025"}',
        ),
      ).toThrow(/names no calendar month/);
    });

    it('refuses a card number that is not one, reporting its length and never its digits', () => {
      const attempt = (): unknown =>
        mapHyperCardCardDetail(
          responseFor(0, 2),
          '{"card_number":"4242424242"}',
        );

      expect(attempt).toThrow(/12–19 digit number \(10 character\(s\)\)/);
      expect(attempt).not.toThrow(/4242424242/);
    });

    it('refuses a full set with no security code', () => {
      expect(() =>
        mapHyperCardCardDetail(
          responseFor(0, 1),
          '{"card_number":"1001022400001101","expire":"04/2025"}',
        ),
      ).toThrow(/no "cvv"/);
    });
  });

  describe('a card field arriving as a JSON number', () => {
    // Refused, never stringified, and that is the opposite of what this folder
    // does with their integer vocabularies — deliberately. `String(2)` loses
    // nothing for a card type; a card secret is not like that.

    it('refuses a numeric cvv rather than stringifying it', () => {
      expect(() =>
        mapHyperCardCardDetail(
          responseFor(0, 1),
          '{"cvv":840,"card_number":"1001022400001101","expire":"04/2025"}',
        ),
      ).toThrow(/"cvv" is a JSON number/);
    });

    it('refuses a numeric card number rather than losing its digits', () => {
      expect(() =>
        mapHyperCardCardDetail(
          responseFor(0, 1),
          '{"cvv":"123","card_number":1001022400001101,"expire":"04/2025"}',
        ),
      ).toThrow(/"card_number" is a JSON number/);
    });

    it('refuses a numeric hosted-page password instead of crashing on it', () => {
      // This one used to be a bare `plaintext.password?.trim()`. Optional
      // chaining guards null and undefined and not a number, so a numeric
      // password threw `TypeError: trim is not a function` — an anonymous 500
      // for a card that is working perfectly, rather than a typed refusal.
      const attempt = (): unknown =>
        mapHyperCardCardDetail(
          responseFor(1, 1),
          '{"url":"https://www.test.com/card","password":888888}',
        );

      expect(attempt).toThrow(HyperCardCardDetailError);
      expect(attempt).not.toThrow(TypeError);
      expect(attempt).toThrow(/"password" is a JSON number/);
    });

    it('still reads their page expiry from either wire form', () => {
      // The contrast worth pinning: `expires_at` *is* an integer vocabulary, so
      // it coerces the way their codes do. Only the fields carrying card
      // material refuse.
      const detail = mapHyperCardCardDetail(
        responseFor(1, 1),
        '{"url":"https://www.test.com/card","expires_at":1772712803}',
      ).expose();

      if (detail.kind !== 'HOSTED_PAGE') throw new Error('wrong arm');
      expect(detail.expiresAt).toBe(new Date(1772712803 * 1000).toISOString());
    });
  });

  describe('their wire types', () => {
    it('reads the obtain way and card type the same whether they send strings or numbers', () => {
      // Their parameter tables declare integers, their example responses
      // contradict that, and their sandbox contradicts both — the same reason
      // every other mapper here coerces rather than trusting a declaration.
      const asNumbers = mapHyperCardCardDetail(
        responseFor(0, 1),
        THEIR_VIRTUAL_API_PAYLOAD,
      ).expose();
      const asStrings = mapHyperCardCardDetail(
        responseFor('0', '1'),
        THEIR_VIRTUAL_API_PAYLOAD,
      ).expose();

      expect(asStrings).toEqual(asNumbers);
    });
  });

  describe('what decrypted to something unusable', () => {
    it('refuses a payload that is not JSON, and points at the padding assumption', () => {
      // A wrong padding scheme surfaces here rather than at the decrypt:
      // OpenSSL implicitly rejects a bad PKCS#1 v1.5 decryption by returning
      // pseudorandom bytes instead of raising.
      expect(() =>
        mapHyperCardCardDetail(responseFor(0, 1), '¡not json'),
      ).toThrow(/decrypted to something other than JSON.*PKCS#1 v1\.5/s);
    });

    it('does not echo the decrypted payload into the refusal', () => {
      // The plaintext is card material. `JSON.parse` quotes its input into its
      // own message, which is why that error is discarded rather than kept as a
      // cause.
      expect(() =>
        mapHyperCardCardDetail(responseFor(0, 1), '{"cvv":"123",'),
      ).not.toThrow(/123/);
    });

    it('refuses JSON that is not an object', () => {
      expect(() =>
        mapHyperCardCardDetail(responseFor(0, 1), '["1001022400001101"]'),
      ).toThrow(/JSON but not to an object/);
    });
  });

  it('returns the union wrapped, so nothing can serialise it by accident', () => {
    const wrapped = mapHyperCardCardDetail(
      responseFor(0, 1),
      THEIR_VIRTUAL_API_PAYLOAD,
    );

    expect(() => JSON.stringify(wrapped)).toThrow(
      /must never be JSON-serialized/,
    );
    expect(wrapped.toString()).toBe('[SensitiveCardDetails: redacted]');
  });
});
