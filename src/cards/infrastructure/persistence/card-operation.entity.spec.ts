import { CARD_OPERATION_IN_FLIGHT_EXPRESSION } from './card-operation.entity';

describe('card_operation in-flight expression', () => {
  it('composes the expression the applied migration wrote', () => {
    // The only automated check that the entity and the database still agree.
    // `schema:log` is what proves it end to end and nothing runs `schema:log`,
    // so without this an edit to the status sets — including reordering the
    // members, which changes the text — diverges from the generated column in
    // silence, and the guard then enforces a different set than the code reads.
    expect(CARD_OPERATION_IN_FLIGHT_EXPRESSION).toBe(
      "IF(`status` IN ('DRAFT', 'SUBMITTED'), `card_id`, NULL)",
    );
  });
});
