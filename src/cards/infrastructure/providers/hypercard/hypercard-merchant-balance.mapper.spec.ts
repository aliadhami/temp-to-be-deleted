import {
  HyperCardMerchantBalanceError,
  mapHyperCardMerchantBalance,
} from './hypercard-merchant-balance.mapper';

describe('mapHyperCardMerchantBalance', () => {
  const observedAt = new Date('2026-02-03T04:05:06.789Z');

  /** The row their "Merchant Balance" page publishes as its example response. */
  const theirRow = {
    amount: '100.00',
    coin: 'usdt',
    total_amount: '100.888888',
  };

  it('maps their example row', () => {
    const result = mapHyperCardMerchantBalance([theirRow], observedAt);

    expect(result.entries).toEqual([
      { currencyCode: 'USDT', available: '100.00', ledger: '100.888888' },
    ]);
  });

  it('takes the observation time from the caller, their payload carrying none', () => {
    const result = mapHyperCardMerchantBalance([theirRow], observedAt);

    expect(result.observedAt).toBe('2026-02-03T04:05:06.789Z');
  });

  it('keeps every coin they publish, in the order they published it', () => {
    const result = mapHyperCardMerchantBalance(
      [
        theirRow,
        { amount: '0.00', coin: 'usdc', total_amount: '0.00' },
        { amount: '1', coin: 'eth', total_amount: '2' },
      ],
      observedAt,
    );

    expect(result.entries.map((entry) => entry.currencyCode)).toEqual([
      'USDT',
      'USDC',
      'ETH',
    ]);
  });

  it('answers an empty float rather than inventing a row', () => {
    expect(mapHyperCardMerchantBalance([], observedAt)).toEqual({
      entries: [],
      observedAt: observedAt.toISOString(),
    });
  });

  it.each([null, undefined])(
    'reads %p as an empty float, an account holding no coin record publishing none',
    (data) => {
      expect(mapHyperCardMerchantBalance(data, observedAt).entries).toEqual([]);
    },
  );

  it.each([{}, '', 'ok', 0, true])(
    'refuses %p, which is not a list of coin balances',
    (data) => {
      expect(() => mapHyperCardMerchantBalance(data, observedAt)).toThrow(
        HyperCardMerchantBalanceError,
      );
    },
  );

  it('refuses two rows naming the same asset', () => {
    expect(() =>
      mapHyperCardMerchantBalance(
        [theirRow, { ...theirRow, amount: '5.00' }],
        observedAt,
      ),
    ).toThrow(HyperCardMerchantBalanceError);
  });

  it('refuses a repeat that differs only in case', () => {
    expect(() =>
      mapHyperCardMerchantBalance(
        [theirRow, { ...theirRow, coin: 'USDT' }],
        observedAt,
      ),
    ).toThrow(HyperCardMerchantBalanceError);
  });

  it('refuses a row that is not an object at all', () => {
    expect(() =>
      mapHyperCardMerchantBalance([theirRow, null], observedAt),
    ).toThrow(HyperCardMerchantBalanceError);
  });

  it('keeps every amount a string, including one they sent unquoted', () => {
    const result = mapHyperCardMerchantBalance(
      [{ amount: 100.5, coin: 'usdt', total_amount: 101 }],
      observedAt,
    );

    expect(result.entries[0]).toEqual({
      currencyCode: 'USDT',
      available: '100.5',
      ledger: '101',
    });
  });

  it.each(['amount', 'total_amount'] as const)(
    'refuses a row whose %s cannot be read, rather than dropping the coin',
    (field) => {
      expect(() =>
        mapHyperCardMerchantBalance([{ ...theirRow, [field]: '' }], observedAt),
      ).toThrow(HyperCardMerchantBalanceError);
    },
  );

  it('refuses a negative amount, which they publish nowhere', () => {
    expect(() =>
      mapHyperCardMerchantBalance(
        [{ ...theirRow, amount: '-1.00' }],
        observedAt,
      ),
    ).toThrow(HyperCardMerchantBalanceError);
  });

  it('refuses a row that names no asset', () => {
    expect(() =>
      mapHyperCardMerchantBalance([{ ...theirRow, coin: '' }], observedAt),
    ).toThrow(HyperCardMerchantBalanceError);
  });

  it('names the coin in the message, so one bad row among several is findable', () => {
    expect(() =>
      mapHyperCardMerchantBalance(
        [theirRow, { amount: 'n/a', coin: 'btc', total_amount: '1' }],
        observedAt,
      ),
    ).toThrow(/btc/);
  });
});
