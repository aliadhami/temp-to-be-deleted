import {
  buildHyperCardCanonicalString,
  pickSignedHeaders,
} from './hypercard-signature.util';

/**
 * Every expected string below is the verbatim output of HyperCard's official
 * demo for the same input.
 */
describe('buildHyperCardCanonicalString', () => {
  it('sorts, merges headers with body, and joins name=value with &', () => {
    const result = buildHyperCardCanonicalString(
      {
        timestamp: '1700000000',
        nonce: 'a1b2c3d4e5',
        'api-key': 'K',
        version: '1.0',
        lang: 'en',
      },
      { coin: 'usdt' },
    );

    expect(result).toBe(
      'api-key=K&coin=usdt&lang=en&nonce=a1b2c3d4e5&timestamp=1700000000&version=1.0',
    );
  });

  it('sorts by code unit, so uppercase and _ precede lowercase', () => {
    const result = buildHyperCardCanonicalString(
      {},
      { zeta: '1', Alpha: '2', alpha: '3', _under: '4' },
    );

    expect(result).toBe('Alpha=2&_under=4&alpha=3&zeta=1');
  });

  it('lets a body field win a name collision with a header', () => {
    // Per their official demo, the body is merged over the headers, so it
    // replaces a header of the same name rather than both being emitted.
    const result = buildHyperCardCanonicalString(
      { timestamp: 'HEADER', 'api-key': 'K' },
      { timestamp: 'BODY' },
    );

    expect(result).toBe('api-key=K&timestamp=BODY');
  });

  it('excludes the signature field itself', () => {
    const result = buildHyperCardCanonicalString(
      { 'api-key': 'K', signature: 'should-never-be-signed' },
      {},
    );

    expect(result).toBe('api-key=K');
  });

  describe('what counts as empty', () => {
    it('drops an empty string and a null', () => {
      expect(
        buildHyperCardCanonicalString(
          {},
          { back_doc: '', front_doc: null, coin: 'usdt' },
        ),
      ).toBe('coin=usdt');
    });

    it('keeps 0 and false — they stringify to non-empty text', () => {
      expect(
        buildHyperCardCanonicalString(
          {},
          { doc_never_expire: 0, is_primary: false, gender: 1 },
        ),
      ).toBe('doc_never_expire=0&gender=1&is_primary=False');
    });

    it('drops a container whose every reachable value is empty', () => {
      expect(
        buildHyperCardCanonicalString({}, { meta: {}, coin: 'usdt' }),
      ).toBe('coin=usdt');
      expect(
        buildHyperCardCanonicalString({}, { meta: { a: '' }, coin: 'usdt' }),
      ).toBe('coin=usdt');
      expect(
        buildHyperCardCanonicalString({}, { tags: [], coin: 'usdt' }),
      ).toBe('coin=usdt');
    });
  });

  describe('value formatting', () => {
    it('serialises a nested object under its own key, not flattened', () => {
      expect(
        buildHyperCardCanonicalString(
          { timestamp: '1', 'api-key': 'K' },
          {
            base_info: { email: 'a@b.com', mobile: '18888' },
            mc_trade_no: 'T1',
          },
        ),
      ).toBe(
        'api-key=K&base_info={"email":"a@b.com","mobile":"18888"}&mc_trade_no=T1&timestamp=1',
      );
    });

    it('keeps empty values *inside* a nested object', () => {
      // The empty-value rule applies only at the top level.
      expect(
        buildHyperCardCanonicalString(
          {},
          { kyc_info: { back_doc: '', birthday: '1990-01-01' } },
        ),
      ).toBe('kyc_info={"back_doc":"","birthday":"1990-01-01"}');
    });

    it('serialises an array', () => {
      expect(
        buildHyperCardCanonicalString({}, { coins: ['usdt', 'btc'] }),
      ).toBe('coins=["usdt","btc"]');
    });

    it('capitalises booleans nested in a container', () => {
      expect(
        buildHyperCardCanonicalString({}, { flags: { active: true } }),
      ).toBe('flags={"active":True}');
    });

    it('leaves numbers unquoted', () => {
      expect(
        buildHyperCardCanonicalString(
          {},
          { kyc: { gender: 1, doc_no: 12345678 } },
        ),
      ).toBe('kyc={"gender":1,"doc_no":12345678}');
      expect(
        buildHyperCardCanonicalString(
          {},
          { zip_code: 100100, mobile: 1880200090 },
        ),
      ).toBe('mobile=1880200090&zip_code=100100');
    });
  });

  describe('their lossy replacement pass', () => {
    // These three are almost certainly unintended on HyperCard's side, but
    // their server verifies against exactly this output, so we reproduce it.
    it('collapses ", " inside a string value', () => {
      expect(
        buildHyperCardCanonicalString(
          {},
          { address: 'maizidianjie28hao, Beijing' },
        ),
      ).toBe('address=maizidianjie28hao,Beijing');
    });

    it('collapses ": " inside a string value', () => {
      expect(buildHyperCardCanonicalString({}, { note: 'key: value' })).toBe(
        'note=key:value',
      );
    });

    it('rewrites an apostrophe to a double quote', () => {
      expect(buildHyperCardCanonicalString({}, { last_name: "O'Brien" })).toBe(
        'last_name=O"Brien',
      );
    });

    it('applies the collapse inside nested values too', () => {
      expect(
        buildHyperCardCanonicalString({}, { kyc: { address: 'x, y' } }),
      ).toBe('kyc={"address":"x,y"}');
    });

    it('replaces every occurrence, not just the first', () => {
      // The replacement is global; a JS string-pattern replace would not be.
      expect(buildHyperCardCanonicalString({}, { list: 'a, b, c, d' })).toBe(
        'list=a,b,c,d',
      );
    });
  });

  it('does not crash on a null nested in a container', () => {
    // Documented deviation: their official demo raises on this shape rather
    // than signing it. We degrade instead — but callers should still omit null
    // nested fields, since their verifier may share that intolerance.
    expect(
      buildHyperCardCanonicalString({}, { kyc: { a: null, b: 'z' } }),
    ).toBe('kyc={"a":None,"b":"z"}');
  });

  describe('pickSignedHeaders', () => {
    it('keeps only the five signed headers and drops transport ones', () => {
      const picked = pickSignedHeaders({
        timestamp: '1700000000',
        nonce: 'a1b2c3d4e5',
        'api-key': 'k',
        version: '1.0',
        lang: 'en',
        signature: 'sig',
        'content-type': 'application/json',
        host: 'pay-api.the-block.com',
        'user-agent': 'HyperCard/1.0',
      });

      expect(Object.keys(picked).sort()).toEqual([
        'api-key',
        'lang',
        'nonce',
        'timestamp',
        'version',
      ]);
    });

    it('lower-cases header names, since HTTP names are case-insensitive', () => {
      expect(pickSignedHeaders({ 'API-KEY': 'k', Timestamp: '1' })).toEqual({
        'api-key': 'k',
        timestamp: '1',
      });
    });
  });
});
