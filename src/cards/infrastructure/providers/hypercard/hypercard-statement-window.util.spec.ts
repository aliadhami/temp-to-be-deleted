import { CardProviderIntentRejectedError } from '../../../domain/card-provider-intent-rejected.error';
import {
  decodeHyperCardStatementCursor,
  encodeHyperCardStatementCursor,
  hyperCardMonthLabel,
  hyperCardMonthLabels,
  HYPERCARD_STATEMENT_MAX_MONTHS,
  resolveHyperCardStatementWindow,
} from './hypercard-statement-window.util';

const seconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

describe('hyperCardMonthLabel', () => {
  it('formats their MMyyyy, which is month then year', () => {
    expect(hyperCardMonthLabel(seconds('2026-08-18T13:38:43Z'))).toBe('082026');
    expect(hyperCardMonthLabel(seconds('2026-01-05T00:00:00Z'))).toBe('012026');
  });

  it('reads the month in Beijing time, not UTC', () => {
    // Their API specification puts every date in their API at GMT+8 and makes
    // the conversion the caller's. These two instants are the same month in UTC
    // and different months in Beijing, which is the eight hours a UTC boundary
    // silently misfiles.
    expect(hyperCardMonthLabel(seconds('2026-07-31T16:00:00Z'))).toBe('082026');
    expect(hyperCardMonthLabel(seconds('2026-07-31T15:59:59Z'))).toBe('072026');
    expect(hyperCardMonthLabel(seconds('2026-07-31T23:00:00Z'))).toBe('082026');
  });

  it('rolls the year over on a Beijing boundary', () => {
    expect(hyperCardMonthLabel(seconds('2025-12-31T16:00:00Z'))).toBe('012026');
    expect(hyperCardMonthLabel(seconds('2025-12-31T15:00:00Z'))).toBe('122025');
  });
});

describe('resolveHyperCardStatementWindow', () => {
  const now = seconds('2026-08-18T13:38:43Z');

  it('defaults to their maximum span, ending now', () => {
    const window = resolveHyperCardStatementWindow({}, null, now);

    expect(window.endTime).toBe('082026');
    expect(window.startTime).toBe('032026');
    expect(hyperCardMonthLabels(window)).toHaveLength(
      HYPERCARD_STATEMENT_MAX_MONTHS,
    );
  });

  it('bounds an unbounded window at the end of the month, not at our clock', () => {
    // The request asks for whole months either way, so stopping the answer at
    // `now` fetches the newest rows and then discards them — and a few seconds
    // of skew between our host and the issuer's is enough to lose one.
    const window = resolveHyperCardStatementWindow({}, null, now);

    expect(window.toSeconds).toBeGreaterThan(now);
    expect(hyperCardMonthLabel(window.toSeconds)).toBe('082026');
    // The last second of August in Beijing, which is 15:59:59Z on the 31st.
    expect(new Date(window.toSeconds * 1000).toISOString()).toBe(
      '2026-08-31T15:59:59.000Z',
    );
  });

  it('takes the caller’s bounds when they supply them', () => {
    const window = resolveHyperCardStatementWindow(
      {
        after: seconds('2026-06-01T00:00:00Z'),
        before: seconds('2026-07-15T00:00:00Z'),
      },
      null,
      now,
    );

    expect(window.startTime).toBe('062026');
    expect(window.endTime).toBe('072026');
    expect(hyperCardMonthLabels(window)).toEqual(['062026', '072026']);
  });

  it('refuses a range wider than the limit on the page it calls', () => {
    // Six months, from their "Single card transaction-v2" page — not the "less
    // than 1 month" on their API specification, and not their merchant-wide
    // query's sixty days. Quoting the wrong one refuses ranges they would serve.
    expect(() =>
      resolveHyperCardStatementWindow(
        {
          after: seconds('2026-01-01T00:00:00Z'),
          before: seconds('2026-08-01T00:00:00Z'),
        },
        null,
        now,
      ),
    ).toThrow(CardProviderIntentRejectedError);
  });

  it('accepts a range exactly at the limit', () => {
    expect(() =>
      resolveHyperCardStatementWindow(
        {
          after: seconds('2026-03-01T00:00:00Z'),
          before: seconds('2026-08-01T00:00:00Z'),
        },
        null,
        now,
      ),
    ).not.toThrow();
  });

  it('refuses bounds the wrong way round', () => {
    expect(() =>
      resolveHyperCardStatementWindow(
        {
          after: seconds('2026-08-01T00:00:00Z'),
          before: seconds('2026-07-01T00:00:00Z'),
        },
        null,
        now,
      ),
    ).toThrow(CardProviderIntentRejectedError);
  });

  it('takes its range from the cursor rather than from the parameters beside it', () => {
    // A page boundary that moved because a caller changed `before` between
    // pages is the failure a cursor exists to prevent.
    const cursor = {
      window: {
        fromSeconds: seconds('2026-06-01T00:00:00Z'),
        toSeconds: seconds('2026-07-15T00:00:00Z'),
      },
      atSeconds: now,
      id: 'tx',
    };

    const window = resolveHyperCardStatementWindow(
      { after: seconds('2026-01-01T00:00:00Z'), before: now },
      cursor,
      now,
    );

    expect(window.startTime).toBe('062026');
    expect(window.endTime).toBe('072026');
  });
});

describe('hyperCardMonthLabels', () => {
  it('lists every month in the range, oldest first', () => {
    const window = resolveHyperCardStatementWindow(
      {
        after: seconds('2025-11-20T00:00:00Z'),
        before: seconds('2026-02-05T00:00:00Z'),
      },
      null,
      seconds('2026-02-05T00:00:00Z'),
    );

    // Computed rather than read back off their answer: their response omits a
    // month with no activity entirely, which the live read confirmed.
    expect(hyperCardMonthLabels(window)).toEqual([
      '112025',
      '122025',
      '012026',
      '022026',
    ]);
  });
});

describe('the cursor', () => {
  const cursor = {
    window: {
      fromSeconds: seconds('2026-03-01T00:00:00Z'),
      toSeconds: seconds('2026-08-18T13:38:43Z'),
    },
    atSeconds: seconds('2026-08-18T13:38:43Z'),
    id: '202608182138436344937976',
  };

  it('round-trips', () => {
    expect(
      decodeHyperCardStatementCursor(encodeHyperCardStatementCursor(cursor)),
    ).toEqual(cursor);
  });

  it('gives away nothing about the issuer’s own paging', () => {
    const encoded = encodeHyperCardStatementCursor(cursor);
    expect(encoded).not.toContain('082026');
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses one it did not issue rather than silently restarting', () => {
    // Falling back to the first page reports success while restarting a
    // caller's pagination, which is how a client loops for ever with no error.
    expect(() => decodeHyperCardStatementCursor('not-a-cursor')).toThrow(
      CardProviderIntentRejectedError,
    );
    expect(() =>
      decodeHyperCardStatementCursor(
        Buffer.from('{"f":1}').toString('base64url'),
      ),
    ).toThrow(CardProviderIntentRejectedError);
    expect(() =>
      decodeHyperCardStatementCursor(Buffer.from('[]').toString('base64url')),
    ).toThrow(CardProviderIntentRejectedError);
  });
});
