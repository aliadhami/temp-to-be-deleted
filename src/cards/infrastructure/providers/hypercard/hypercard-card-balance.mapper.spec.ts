import {
  HyperCardCardBalanceError,
  mapHyperCardCardBalance,
} from './hypercard-card-balance.mapper';

describe('mapHyperCardCardBalance', () => {
  /** Fixed, so the assertion below is about the value that was passed in. */
  const observedAt = new Date('2026-08-18T21:36:57.000Z');

  /** Their "Balance Inquiry" example response, verbatim. */
  const theirExample = {
    available_balance: '100.00',
    card_currency: 'usd',
    card_number: '111111******0628',
    card_type: 'N/A',
    current_balance: '1000.00',
  };

  /** Their payload with one key removed. */
  const without = (key: keyof typeof theirExample) => {
    const copy: Record<string, unknown> = { ...theirExample };
    delete copy[key];
    return copy;
  };

  it('maps their own example response', () => {
    expect(mapHyperCardCardBalance(theirExample, observedAt)).toEqual({
      // Their labelling: the available figure is what can be spent, the
      // current one is the ledger.
      available: '100.00',
      ledger: '1000.00',
      currencyCode: 'USD',
      observedAt: '2026-08-18T21:36:57.000Z',
    });
  });

  it('maps the payload their sandbox actually returns', () => {
    // Read live while proving the deposit request: the same five fields, an
    // empty card type, and both figures equal.
    const live = {
      card_number: '111111******0628',
      card_type: '',
      card_currency: 'usd',
      current_balance: '18.75',
      available_balance: '18.75',
    };

    expect(mapHyperCardCardBalance(live, observedAt)).toEqual({
      available: '18.75',
      ledger: '18.75',
      currencyCode: 'USD',
      observedAt: '2026-08-18T21:36:57.000Z',
    });
  });

  it('carries the decimal string across unchanged, in the currency’s own units', () => {
    // The amount decision, pinned at the layer that could break it: nothing
    // multiplies, nothing rounds, nothing reformats. Their appendix has seven
    // currencies whose minor-unit exponent is not two, so no constant could do
    // the conversion an earlier reading of these columns implied.
    const result = mapHyperCardCardBalance(
      { ...theirExample, available_balance: '10.00', current_balance: '10.00' },
      observedAt,
    );

    expect(result.available).toBe('10.00');
    expect(result.ledger).toBe('10.00');
  });

  it('accepts the figures in their unquoted form', () => {
    // Their transaction pages publish the same fields as numbers on one page
    // and strings on another, so neither column of their documentation is
    // trustworthy on its own.
    const result = mapHyperCardCardBalance(
      { ...theirExample, available_balance: 18.75, current_balance: 20 },
      observedAt,
    );

    expect(result.available).toBe('18.75');
    expect(result.ledger).toBe('20');
  });

  it('uses the observation time it was given, since they publish none', () => {
    const result = mapHyperCardCardBalance(
      theirExample,
      new Date('2020-01-02T03:04:05.678Z'),
    );

    expect(result.observedAt).toBe('2020-01-02T03:04:05.678Z');
  });

  it.each([
    ['an empty string', { ...theirExample, available_balance: '' }],
    ['prose', { ...theirExample, available_balance: 'N/A' }],
    ['an absent key', without('available_balance')],
    ['a negative figure', { ...theirExample, available_balance: '-1.00' }],
  ])('refuses an available balance that is %s', (_case, data) => {
    expect(() => mapHyperCardCardBalance(data, observedAt)).toThrow(
      HyperCardCardBalanceError,
    );
  });

  it('refuses an unreadable ledger figure', () => {
    // Both figures are named separately so the message says which one was
    // unreadable — the balance columns are written together and a message
    // naming neither sends the next reader to the wrong field.
    expect(() =>
      mapHyperCardCardBalance(
        { ...theirExample, current_balance: '' },
        observedAt,
      ),
    ).toThrow(/current_balance/);
  });

  it.each([
    ['an empty string', { ...theirExample, card_currency: '' }],
    ['absent', without('card_currency')],
    ['longer than an ISO code', { ...theirExample, card_currency: 'usdt' }],
  ])('refuses a currency that is %s', (_case, data) => {
    // `card.balance_currency` is three characters wide, and this issuer's cards
    // are denominated in fiat — a coin ticker here means the payload is not
    // describing what we think it is.
    expect(() => mapHyperCardCardBalance(data, observedAt)).toThrow(
      HyperCardCardBalanceError,
    );
  });

  it('never reports a masked number back to its caller', () => {
    // Their response carries one and the card row already holds one, filled by
    // the lookup that opened the card. A balance read is not the place to
    // rewrite it, and their sandbox answers at least one endpoint with the
    // same canned card for every id.
    expect(
      Object.values(mapHyperCardCardBalance(theirExample, observedAt)),
    ).not.toContain(theirExample.card_number);
  });
});
