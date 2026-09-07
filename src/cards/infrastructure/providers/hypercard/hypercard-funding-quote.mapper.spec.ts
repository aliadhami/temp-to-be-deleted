import {
  HyperCardFundingQuoteError,
  mapHyperCardFundingQuote,
} from './hypercard-funding-quote.mapper';

describe('mapHyperCardFundingQuote', () => {
  const QUOTED_AT = new Date('2026-02-03T04:05:06.789Z');

  const context = (overrides: Record<string, unknown> = {}) => ({
    payCoin: 'usdt',
    cardCurrencyCode: 'USD',
    quotedAt: QUOTED_AT,
    ...overrides,
  });

  /** Their wire sends `""` rather than omitting a key, so one is dropped here. */
  const omit = (
    payload: Record<string, unknown>,
    field: string,
  ): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(payload).filter(([key]) => key !== field),
    );

  /** Their "Estimate crypto" documented sample, verbatim. */
  const theirSample = {
    card_coin: 'usd',
    coin_exchange_usd_rate: '1',
    currency_amount: '188',
    currency_exchange_usd_rate: '1',
    pay_coin: 'usdt',
    real_recharge_amount: '188',
    recharge_amount: '188.88',
    recharge_fee_amount: '0.88',
    recharge_fee_usdt_amount: '0.88',
  };

  it('reads their documented sample, both directions of recharge_amount', () => {
    const quote = mapHyperCardFundingQuote(theirSample, context());

    // Asked for 188 fiat: `currency_amount` is what lands, `recharge_amount`
    // what it costs in the coin.
    expect(quote.credited).toEqual({ amount: '188', currencyCode: 'USD' });
    expect(quote.cost).toEqual({ amount: '188.88', currencyCode: 'USDT' });
    expect(quote.fee).toEqual({ amount: '0.88', currencyCode: 'USDT' });
    expect(quote.quotedAt).toBe(QUOTED_AT.toISOString());
  });

  it('reads the same fields when they arrive as JSON numbers', () => {
    const quote = mapHyperCardFundingQuote(
      {
        ...theirSample,
        currency_amount: 188,
        recharge_amount: 188.88,
        recharge_fee_amount: 0.88,
      },
      context(),
    );

    expect(quote.credited.amount).toBe('188');
    expect(quote.cost.amount).toBe('188.88');
    expect(quote.fee.amount).toBe('0.88');
  });

  it.each([
    ['currency_amount', 'currency_amount'],
    ['recharge_amount', 'recharge_amount'],
    ['recharge_fee_amount', 'recharge_fee_amount'],
  ])('refuses an unreadable %s rather than answering zero', (field) => {
    expect(() =>
      mapHyperCardFundingQuote({ ...theirSample, [field]: '' }, context()),
    ).toThrow(HyperCardFundingQuoteError);
  });

  it('refuses a cost priced in a coin other than the one asked for', () => {
    expect(() =>
      mapHyperCardFundingQuote({ ...theirSample, pay_coin: 'btc' }, context()),
    ).toThrow(/priced a deposit in btc/);
  });

  it('accepts an echo differing only in case', () => {
    const quote = mapHyperCardFundingQuote(
      { ...theirSample, pay_coin: 'USDT' },
      context(),
    );

    expect(quote.cost.currencyCode).toBe('USDT');
  });

  it('falls back to the coin that was sent when they echo none', () => {
    const quote = mapHyperCardFundingQuote(
      omit(theirSample, 'pay_coin'),
      context(),
    );

    expect(quote.cost.currencyCode).toBe('USDT');
    expect(quote.fee.currencyCode).toBe('USDT');
  });

  it('publishes the currency they quoted, not the one that was asked about', () => {
    const quote = mapHyperCardFundingQuote(
      { ...theirSample, card_coin: 'eur' },
      context(),
    );

    expect(quote.credited.currencyCode).toBe('EUR');
  });

  it("falls back to the product's currency when they echo none", () => {
    const quote = mapHyperCardFundingQuote(
      omit(theirSample, 'card_coin'),
      context(),
    );

    expect(quote.credited.currencyCode).toBe('USD');
  });

  it.each([
    ['a list', [theirSample]],
    ['a string', 'ok'],
    ['null', null],
  ])('refuses %s where their page documents an object', (_label, payload) => {
    expect(() => mapHyperCardFundingQuote(payload, context())).toThrow(
      HyperCardFundingQuoteError,
    );
  });
});
