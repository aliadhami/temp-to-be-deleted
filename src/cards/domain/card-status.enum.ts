export enum CardStatus {
  NOT_ACTIVATED = 'NOT_ACTIVATED',
  ACTIVE = 'ACTIVE',
  ON_HOLD = 'ON_HOLD',
  CLOSED = 'CLOSED',
}

/**
 * The statuses nothing may move a card out of. **Listed, never derived.**
 *
 * A compare-and-set cannot express this: it keys on the status read, so a
 * closed card matches itself and the write goes through.
 */
export const TERMINAL_CARD_STATUSES: readonly CardStatus[] = [
  CardStatus.CLOSED,
];
