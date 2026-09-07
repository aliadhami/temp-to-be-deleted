import {
  CardDepositStatus,
  OUTSTANDING_CARD_DEPOSIT_STATUSES,
  TERMINAL_CARD_DEPOSIT_STATUSES,
  UNSENT_CARD_DEPOSIT_STATUSES,
} from './card-deposit-status.enum';

/**
 * The three sets have to partition the enum, and the direction the derivation
 * defaults in is the thing worth holding in place.
 */
describe('CardDepositStatus sets', () => {
  const all = Object.values(CardDepositStatus);

  it('covers every member exactly once', () => {
    const partitioned = [
      ...TERMINAL_CARD_DEPOSIT_STATUSES,
      ...UNSENT_CARD_DEPOSIT_STATUSES,
      ...OUTSTANDING_CARD_DEPOSIT_STATUSES,
    ];

    expect(partitioned).toHaveLength(all.length);
    expect(new Set(partitioned)).toEqual(new Set(all));
  });

  it('polls a member that is in neither excluded set', () => {
    // The derivation's whole point, asserted rather than assumed: every member
    // not deliberately excluded is asked about. A future state added for a new
    // issuer behaviour is watched until somebody decides otherwise.
    for (const status of all) {
      const excluded =
        TERMINAL_CARD_DEPOSIT_STATUSES.includes(status) ||
        UNSENT_CARD_DEPOSIT_STATUSES.includes(status);

      expect(OUTSTANDING_CARD_DEPOSIT_STATUSES.includes(status)).toBe(
        !excluded,
      );
    }
  });

  it('keeps their non-final failure outstanding', () => {
    // Their own recharge-status table marks failure not final: the funding
    // account is debited on acceptance, so a failure afterwards is returned
    // rather than lost. A pass that stopped watching here would tell a partner
    // money was lost which in fact came back.
    expect(OUTSTANDING_CARD_DEPOSIT_STATUSES).toContain(
      CardDepositStatus.FAILED,
    );
    expect(TERMINAL_CARD_DEPOSIT_STATUSES).not.toContain(
      CardDepositStatus.FAILED,
    );
  });

  it('treats a request the issuer declined outright as terminal', () => {
    // No order exists behind it to settle or refund, so polling it would ask
    // about a reference they never created, on a set that never drains.
    expect(TERMINAL_CARD_DEPOSIT_STATUSES).toContain(
      CardDepositStatus.REJECTED,
    );
  });

  it('does not poll a request the issuer never received', () => {
    expect(OUTSTANDING_CARD_DEPOSIT_STATUSES).not.toContain(
      CardDepositStatus.DRAFT,
    );
    expect(OUTSTANDING_CARD_DEPOSIT_STATUSES).not.toContain(
      CardDepositStatus.SUBMISSION_FAILED,
    );
  });
});
