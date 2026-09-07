import { Logger } from '@nestjs/common';
import {
  HyperCardTransactionError,
  mapHyperCardTransaction,
  readHyperCardStatementRows,
  readHyperCardStatementRowSeconds,
} from './hypercard-transaction.mapper';
import { HyperCardTransactionRow } from './hypercard.types';

/**
 * Their live statement row, taken from a real read of the sandbox account
 * rather than from their documentation — which their own example contradicts
 * on four fields: it publishes `credit`, `debit`, `tx_amount` and `fee` as
 * JSON numbers, and omits the status its parameter table declares.
 */
const theirRow = (
  overrides: Partial<HyperCardTransactionRow> = {},
): HyperCardTransactionRow => ({
  tx_id: '202608182138436344937976',
  description: '',
  debit: '0.00000000',
  credit: '11.00000000',
  fee: '0.00000000',
  type: 2,
  tx_currency: 'usd',
  tx_amount: '11.00000000',
  status: 1,
  transaction_date: '1787060323',
  posting_date: '1787060323',
  mc_trade_no: 'aa7dafbbb38342cbb5af121bfaa65f4f',
  ...overrides,
});

describe('mapHyperCardTransaction', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('maps their live statement row', () => {
    expect(mapHyperCardTransaction(theirRow())).toEqual({
      id: '202608182138436344937976',
      amount: '11.00000000',
      currencyCode: 'USD',
      status: 'settled',
      category: 'recharge',
      merchantName: null,
      merchantAmount: null,
      merchantCurrency: null,
      createdAt: '2026-08-18T13:38:43.000Z',
      settledAt: '2026-08-18T13:38:43.000Z',
    });
  });

  it('carries the amount across exactly as sent, without reformatting it', () => {
    // Their eight decimal places on a US dollar row are theirs. Trimming them
    // would mean deciding how many places their figure was entitled to, and
    // nothing here can decide that for a currency whose exponent may not be two.
    expect(mapHyperCardTransaction(theirRow()).amount).toBe('11.00000000');
    expect(
      mapHyperCardTransaction(theirRow({ tx_amount: '2.5', credit: '2.5' }))
        .amount,
    ).toBe('2.5');
  });

  it('accepts the number forms their own example publishes', () => {
    // Their single-card page's example returns these four as numbers where the
    // live endpoint returns strings, so both shapes are theirs.
    const mapped = mapHyperCardTransaction(
      theirRow({ credit: 2.5, debit: 0, fee: 0, tx_amount: 2.5, status: 1 }),
    );
    expect(mapped.amount).toBe('2.5');
    expect(mapped.status).toBe('settled');
  });

  describe('direction', () => {
    it('is negative when only the debit is populated', () => {
      expect(
        mapHyperCardTransaction(
          theirRow({ credit: '0.00000000', debit: '11.00000000', type: 1 }),
        ).amount,
      ).toBe('-11.00000000');
    });

    it('is positive when only the credit is populated', () => {
      expect(mapHyperCardTransaction(theirRow()).amount).toBe('11.00000000');
    });

    it('is unsigned when their pair decides nothing, which is their own sample shape', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      expect(
        mapHyperCardTransaction(
          theirRow({ credit: '2.5', debit: '2.5', tx_amount: '2.5' }),
        ).amount,
      ).toBe('2.5');
      expect(warn).toHaveBeenCalled();
    });

    it('says nothing about a zero amount, which has no direction to get wrong', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      expect(
        mapHyperCardTransaction(
          theirRow({ credit: '0', debit: '0', tx_amount: '0.00000000' }),
        ).amount,
      ).toBe('0.00000000');
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('their transaction type', () => {
    it('maps every code in their appendix', () => {
      expect(mapHyperCardTransaction(theirRow({ type: 1 })).category).toBe(
        'consume',
      );
      expect(mapHyperCardTransaction(theirRow({ type: 8 })).category).toBe(
        'refund',
      );
      expect(mapHyperCardTransaction(theirRow({ type: 102 })).category).toBe(
        'cancel_card',
      );
    });

    it('keeps a row whose type is not in their appendix, and warns', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      const mapped = mapHyperCardTransaction(theirRow({ type: 4242 }));

      // The row is listed rather than dropped: a transaction we cannot model
      // still happened, and hiding it makes a statement wrong rather than
      // incomplete.
      expect(mapped.category).toBe('unknown');
      expect(mapped.id).toBe('202608182138436344937976');
      expect(warn).toHaveBeenCalled();
    });
  });

  describe('their transaction status', () => {
    it('maps their three codes', () => {
      expect(mapHyperCardTransaction(theirRow({ status: 0 })).status).toBe(
        'pending',
      );
      expect(mapHyperCardTransaction(theirRow({ status: 1 })).status).toBe(
        'settled',
      );
      expect(mapHyperCardTransaction(theirRow({ status: 2 })).status).toBe(
        'failed',
      );
    });

    it('does not read an absent status as success', () => {
      // Their own statement example omits the field their parameter table
      // declares. Guessing success is the expensive direction: a partner told a
      // transaction settled has no reason to look again.
      const row = theirRow();
      delete row.status;
      expect(mapHyperCardTransaction(row).status).toBe('pending');
    });

    it('does not read a status outside their appendix as success either', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      expect(mapHyperCardTransaction(theirRow({ status: 9 })).status).toBe(
        'pending',
      );
      expect(warn).toHaveBeenCalled();
    });
  });

  describe('their identifier', () => {
    it('takes the quoted twenty-four digit form the live endpoint sends', () => {
      expect(mapHyperCardTransaction(theirRow()).id).toBe(
        '202608182138436344937976',
      );
    });

    it('takes a number that stringifies exactly', () => {
      // Their own examples publish tx_id unquoted. This one is inside exact
      // integer range, so nothing was lost on the way through the parser.
      expect(mapHyperCardTransaction(theirRow({ tx_id: 54675678678 })).id).toBe(
        '54675678678',
      );
    });

    it('keeps the row when a number is past exact range, and warns', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      // Parsed from a string, because a literal long enough to demonstrate this
      // trips `no-loss-of-precision` — which is the same point this case makes.
      const rounded = JSON.parse('202608182138436344937976') as number;

      const mapped = mapHyperCardTransaction(theirRow({ tx_id: rounded }));

      // Digits, not `2.0260818213843634e+23`. The value has already lost its
      // last figures in the parser and cannot be recovered, but publishing it
      // in exponential notation would make it unmatchable against anything a
      // partner holds as well as inexact.
      expect(mapped.id).toMatch(/^\d+$/);
      expect(mapped.id).toBe(BigInt(rounded).toString());
      expect(warn).toHaveBeenCalled();
    });

    it('refuses a row with no identifier at all', () => {
      expect(() => mapHyperCardTransaction(theirRow({ tx_id: '' }))).toThrow(
        HyperCardTransactionError,
      );
    });
  });

  describe('what it refuses', () => {
    it('refuses an unreadable amount rather than publishing a wrong one', () => {
      expect(() =>
        mapHyperCardTransaction(theirRow({ tx_amount: 'eleven' })),
      ).toThrow(HyperCardTransactionError);
    });

    it('refuses a row with no currency', () => {
      expect(() =>
        mapHyperCardTransaction(theirRow({ tx_currency: '' })),
      ).toThrow(HyperCardTransactionError);
    });

    it('refuses a row with no readable transaction date', () => {
      expect(() =>
        mapHyperCardTransaction(theirRow({ transaction_date: 'yesterday' })),
      ).toThrow(HyperCardTransactionError);
    });
  });

  describe('a signed amount, which their reversal types could publish', () => {
    it('keeps a negative the issuer published when their pair decides nothing', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');

      // The shared coercion refuses negatives outright, because a negative fee
      // or balance is a payload nobody understands.
      const mapped = mapHyperCardTransaction(
        theirRow({ tx_amount: '-2.5', credit: '0', debit: '0', type: 9 }),
      );

      expect(mapped.amount).toBe('-2.5');
      expect(warn).toHaveBeenCalled();
    });

    it('lets their debit/credit pair override a sign on the amount', () => {
      // The pair is the direct statement about direction; the sign is the
      // fallback for when it says nothing.
      expect(
        mapHyperCardTransaction(
          theirRow({ tx_amount: '-2.5', credit: '2.5', debit: '0' }),
        ).amount,
      ).toBe('2.5');
    });
  });

  describe('readHyperCardStatementRows', () => {
    it('flattens every statement in their answer', () => {
      expect(
        readHyperCardStatementRows([
          { month_year: '072026', bank_tx_list: [theirRow()] },
          { month_year: '082026', bank_tx_list: [theirRow(), theirRow()] },
        ]),
      ).toHaveLength(3);
    });

    it('reads a missing payload as an empty statement, not an error', () => {
      // Their endpoints answer a legitimate "nothing here" with no `data` at
      // all, and a card that has never transacted is exactly that case.
      expect(readHyperCardStatementRows(null)).toEqual([]);
      expect(readHyperCardStatementRows(undefined)).toEqual([]);
      expect(readHyperCardStatementRows([])).toEqual([]);
    });

    it('tolerates a statement carrying no transaction list', () => {
      expect(readHyperCardStatementRows([{ month_year: '082026' }])).toEqual(
        [],
      );
    });

    it('refuses a payload that is not a list of statements', () => {
      // Nothing validates a response body against the type a caller asked the
      // transport for, and they have contradicted their own documentation on
      // five fields of this endpoint already.
      expect(() => readHyperCardStatementRows({ records: [] })).toThrow(
        HyperCardTransactionError,
      );
      expect(() => readHyperCardStatementRows('nope')).toThrow(
        HyperCardTransactionError,
      );
    });

    it('refuses a statement whose transaction list is not a list', () => {
      expect(() =>
        readHyperCardStatementRows([
          { month_year: '082026', bank_tx_list: 'nope' },
        ]),
      ).toThrow(HyperCardTransactionError);
    });
  });

  describe('readHyperCardStatementRowSeconds', () => {
    it('reads when a row happened, before anything else about it', () => {
      expect(readHyperCardStatementRowSeconds(theirRow())).toBe(1787060323);
      expect(
        readHyperCardStatementRowSeconds(
          theirRow({ transaction_date: 1787060323 }),
        ),
      ).toBe(1787060323);
    });

    it('answers null for a row that cannot be placed in time', () => {
      // A caller keeps such a row rather than dropping it: a row that cannot be
      // dated cannot be shown to be outside a range either.
      expect(
        readHyperCardStatementRowSeconds(
          theirRow({ transaction_date: 'yesterday' }),
        ),
      ).toBeNull();
    });
  });

  it('leaves the description off entirely when they send an empty one', () => {
    // Their empty fields arrive as `""`, not as absent keys, and an optional
    // cannot be set to undefined under `exactOptionalPropertyTypes`.
    expect(mapHyperCardTransaction(theirRow())).not.toHaveProperty(
      'description',
    );
    expect(
      mapHyperCardTransaction(theirRow({ description: 'MONTHLY FEE' }))
        .description,
    ).toBe('MONTHLY FEE');
  });

  it('publishes a coin-denominated row in the coin, which they document for a cancelled card', () => {
    expect(
      mapHyperCardTransaction(theirRow({ type: 102, tx_currency: 'usdt' }))
        .currencyCode,
    ).toBe('USDT');
  });

  it('leaves settledAt null when they publish no posting date', () => {
    const row = theirRow();
    delete row.posting_date;
    expect(mapHyperCardTransaction(row).settledAt).toBeNull();
  });
});
