import { CARD_PROVIDER_CALLBACK_DEDUPE_EXPRESSION } from './card-provider-callback.entity';

describe('card_provider_callback dedupe expression', () => {
  it('composes the expression the applied migration wrote', () => {
    // The only automated check that the entity and the database still agree.
    // `schema:log` is what proves it end to end and nothing runs `schema:log`,
    // so without this an edit here — including a cosmetic one, since the text
    // is compared verbatim — diverges from the generated column in silence and
    // the duplicate check stops matching what the code believes it enforces.
    expect(CARD_PROVIDER_CALLBACK_DEDUPE_EXPRESSION).toBe(
      'IF(`signature_valid`, ' +
        "CONCAT(CHAR_LENGTH(`provider_key`), ':', `provider_key`, `delivery_key`)" +
        ', NULL)',
    );
  });
});
