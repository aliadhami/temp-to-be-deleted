import {
  CardOperationStatus,
  IN_FLIGHT_CARD_OPERATION_STATUSES,
  OUTSTANDING_CARD_OPERATION_STATUSES,
  TERMINAL_CARD_OPERATION_STATUSES,
  UNSENT_CARD_OPERATION_STATUSES,
} from './card-operation-status.enum';

/**
 * Two derivations run off the same enum, and the direction each defaults in is
 * the thing worth holding in place.
 */
describe('CardOperationStatus sets', () => {
  const all = Object.values(CardOperationStatus);

  it('covers every member exactly once', () => {
    const partitioned = [
      ...TERMINAL_CARD_OPERATION_STATUSES,
      ...UNSENT_CARD_OPERATION_STATUSES,
      ...OUTSTANDING_CARD_OPERATION_STATUSES,
    ];

    expect(partitioned).toHaveLength(all.length);
    expect(new Set(partitioned)).toEqual(new Set(all));
  });

  it('polls a member that is in neither excluded set', () => {
    // A state added later is asked about until somebody decides otherwise.
    for (const status of all) {
      const excluded =
        TERMINAL_CARD_OPERATION_STATUSES.includes(status) ||
        UNSENT_CARD_OPERATION_STATUSES.includes(status);

      expect(OUTSTANDING_CARD_OPERATION_STATUSES.includes(status)).toBe(
        !excluded,
      );
    }
  });

  it('holds the card for a member that is neither terminal nor known unsent', () => {
    for (const status of all) {
      const released =
        TERMINAL_CARD_OPERATION_STATUSES.includes(status) ||
        status === CardOperationStatus.SUBMISSION_FAILED;

      expect(IN_FLIGHT_CARD_OPERATION_STATUSES.includes(status)).toBe(
        !released,
      );
    }
  });

  it('holds the card for a request written but not yet acknowledged, without polling it', () => {
    // The one state the two derivations disagree on: a row written before the
    // call may be mid-flight, so a second request must collide with it, but no
    // reference has reached the issuer to look up.
    expect(IN_FLIGHT_CARD_OPERATION_STATUSES).toContain(
      CardOperationStatus.DRAFT,
    );
    expect(OUTSTANDING_CARD_OPERATION_STATUSES).not.toContain(
      CardOperationStatus.DRAFT,
    );
  });

  it('frees the card once a request is known not to have landed', () => {
    // Refusing the next request here would strand the card on an attempt the
    // issuer never received.
    expect(IN_FLIGHT_CARD_OPERATION_STATUSES).not.toContain(
      CardOperationStatus.SUBMISSION_FAILED,
    );
  });

  it('treats a request the issuer declined outright as terminal', () => {
    // Neither "never sent" nor "accepted and then failed", and polling it would
    // ask about a reference the issuer never created.
    expect(TERMINAL_CARD_OPERATION_STATUSES).toContain(
      CardOperationStatus.REJECTED,
    );
  });

  it('treats a failed operation as terminal, unlike a failed deposit', () => {
    // No money moved, so there is no refund to wait for and no state after it.
    expect(TERMINAL_CARD_OPERATION_STATUSES).toContain(
      CardOperationStatus.FAILED,
    );
    expect(OUTSTANDING_CARD_OPERATION_STATUSES).not.toContain(
      CardOperationStatus.FAILED,
    );
  });
});
