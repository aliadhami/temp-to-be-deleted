import { CardProviderIntentRejectedError } from '../../../domain/card-provider-intent-rejected.error';
import { CardProviderKey } from '../../../domain/card-provider-key.enum';

/**
 * The month arithmetic and the cursor behind their card statement. Their
 * statement endpoint has no pagination at all — it takes a start and an end
 * month, both `MMyyyy`, and answers one statement object per month.
 */

/**
 * Beijing time, where every date in their API lives — their spec puts the
 * conversion on the caller.
 */
const BEIJING_OFFSET_SECONDS = 8 * 60 * 60;

/**
 * How many calendar months one call may span. Six, from their "Single card
 * transaction-v2" page, which is the page this adapter calls.
 */
export const HYPERCARD_STATEMENT_MAX_MONTHS = 6;

/** What one call to their statement endpoint asks for, and the bounds to apply to its answer. */
export interface HyperCardStatementWindow {
  /** `MMyyyy`, GMT+8. */
  startTime: string;
  /** `MMyyyy`, GMT+8. */
  endTime: string;
  /**
   * Unix seconds. Their statements are whole months, so an answer reaches past
   * the range a caller asked for at both ends and is trimmed to these.
   */
  fromSeconds: number;
  toSeconds: number;
}

/** Where a page left off: the last row's sort position. */
export interface HyperCardStatementCursor {
  window: Pick<HyperCardStatementWindow, 'fromSeconds' | 'toSeconds'>;
  /** Unix seconds of the last row returned. */
  atSeconds: number;
  /** Its id, which breaks a tie between two rows in the same second. */
  id: string;
}

interface BeijingMonth {
  year: number;
  month: number;
}

const beijingMonth = (epochSeconds: number): BeijingMonth => {
  const shifted = new Date((epochSeconds + BEIJING_OFFSET_SECONDS) * 1000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };
};

/** Months since year zero, so a span crossing a new year is one subtraction. */
const monthIndex = ({ year, month }: BeijingMonth): number =>
  year * 12 + (month - 1);

const monthFromIndex = (index: number): BeijingMonth => ({
  year: Math.floor(index / 12),
  month: (index % 12) + 1,
});

/** The first instant of a Beijing month, as Unix seconds. */
const monthStartSeconds = ({ year, month }: BeijingMonth): number =>
  Date.UTC(year, month - 1, 1) / 1000 - BEIJING_OFFSET_SECONDS;

/** The last instant of a Beijing month, as Unix seconds. */
const monthEndSeconds = (month: BeijingMonth): number =>
  monthStartSeconds(monthFromIndex(monthIndex(month) + 1)) - 1;

/**
 * The first instant of the Beijing month `monthsBack` before the one
 * containing `epochSeconds`.
 */
export const hyperCardMonthStartSecondsBefore = (
  epochSeconds: number,
  monthsBack: number,
): number =>
  monthStartSeconds(
    monthFromIndex(monthIndex(beijingMonth(epochSeconds)) - monthsBack),
  );

/** Their `MMyyyy`, which is month-then-year and not the other way round. */
export const hyperCardMonthLabel = (epochSeconds: number): string => {
  const { year, month } = beijingMonth(epochSeconds);
  return `${String(month).padStart(2, '0')}${year}`;
};

/**
 * Every month label their call has to cover, oldest first. Computed rather
 * than read back off the response — nothing on their page promises a statement
 * for a month with no activity.
 */
export const hyperCardMonthLabels = (
  window: HyperCardStatementWindow,
): string[] => {
  const first = monthIndex(beijingMonth(window.fromSeconds));
  const last = monthIndex(beijingMonth(window.toSeconds));

  return Array.from({ length: last - first + 1 }, (_unused, offset) =>
    hyperCardMonthLabel(monthStartSeconds(monthFromIndex(first + offset))),
  );
};

const refuse = (field: string, reason: string): never => {
  throw new CardProviderIntentRejectedError(
    CardProviderKey.HYPERCARD,
    field,
    reason,
  );
};

/**
 * The window one call covers, from the port's own parameters. A cursor's
 * window wins over the parameters that arrive with it, so a caller paging
 * through a range gets the same range on every page.
 */
export const resolveHyperCardStatementWindow = (
  params: { before?: number; after?: number },
  cursor: HyperCardStatementCursor | null,
  now: number,
): HyperCardStatementWindow => {
  // **The unbounded upper bound is the end of the current month, not `now`.**
  // The request asks for whole months either way, so bounding at our own clock
  // fetches rows and discards the newest — exactly what a caller polling after
  // a deposit is waiting for. A few seconds of clock skew is enough to lose one.
  const toSeconds =
    cursor?.window.toSeconds ??
    params.before ??
    monthEndSeconds(beijingMonth(now));
  const fromSeconds =
    cursor?.window.fromSeconds ??
    params.after ??
    hyperCardMonthStartSecondsBefore(
      toSeconds,
      HYPERCARD_STATEMENT_MAX_MONTHS - 1,
    );

  if (fromSeconds > toSeconds) {
    refuse('after', 'it is later than "before"');
  }

  const first = monthIndex(beijingMonth(fromSeconds));
  const last = monthIndex(beijingMonth(toSeconds));
  const months = last - first + 1;
  if (months > HYPERCARD_STATEMENT_MAX_MONTHS) {
    refuse(
      'after',
      `the issuer's card statement covers at most ${HYPERCARD_STATEMENT_MAX_MONTHS} calendar months in one request and this range covers ${months}`,
    );
  }

  return {
    startTime: hyperCardMonthLabel(fromSeconds),
    endTime: hyperCardMonthLabel(toSeconds),
    fromSeconds,
    toSeconds,
  };
};

/** A cursor, as a value a partner cannot read anything out of. */
export const encodeHyperCardStatementCursor = (
  cursor: HyperCardStatementCursor,
): string =>
  Buffer.from(
    JSON.stringify({
      f: cursor.window.fromSeconds,
      t: cursor.window.toSeconds,
      a: cursor.atSeconds,
      i: cursor.id,
    }),
  ).toString('base64url');

/**
 * Reads one back, refusing anything it did not mint. Refused rather than
 * ignored.
 */
export const decodeHyperCardStatementCursor = (
  cursor: string,
): HyperCardStatementCursor => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return refuse('cursor', 'it is not a continuation token this issued');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return refuse('cursor', 'it is not a continuation token this issued');
  }

  const { f, t, a, i } = parsed as Record<string, unknown>;
  if (
    typeof f !== 'number' ||
    typeof t !== 'number' ||
    typeof a !== 'number' ||
    typeof i !== 'string'
  ) {
    return refuse('cursor', 'it is not a continuation token this issued');
  }

  return {
    window: { fromSeconds: f, toSeconds: t },
    atSeconds: a,
    id: i,
  };
};
