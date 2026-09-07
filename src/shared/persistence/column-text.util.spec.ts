import { truncateToColumn, truncatedOrNull } from './column-text.util';

describe('truncateToColumn', () => {
  it('leaves a value inside the width exactly as it is', () => {
    expect(truncateToColumn('short', 40)).toBe('short');
  });

  it('cuts a value past the width', () => {
    expect(truncateToColumn('abcdef', 3)).toBe('abc');
  });

  it('never splits a surrogate pair, which the server would refuse', () => {
    // Two code points, four UTF-16 units. `slice(0, 3)` would leave a lone
    // surrogate, which is not valid UTF-8 and fails the write.
    const pair = '👍👍';
    expect(pair).toHaveLength(4);

    const cut = truncateToColumn(pair, 3);

    expect([...cut]).toHaveLength(2);
    expect(cut).toBe(pair);
    expect(truncateToColumn(pair, 1)).toBe('👍');
  });

  it('counts characters the way the column does, not UTF-16 units', () => {
    // Four code points against a width of four: nothing to cut, even though
    // `String.length` reports eight.
    expect(truncateToColumn('👍👍👍👍', 4)).toBe('👍👍👍👍');
  });
});

describe('truncatedOrNull', () => {
  it('answers null for a value the issuer did not send', () => {
    expect(truncatedOrNull(undefined, 40)).toBeNull();
  });

  it('cuts a value the same way', () => {
    expect(truncatedOrNull('abcdef', 3)).toBe('abc');
    expect(truncatedOrNull('👍👍', 3)).toBe('👍👍');
  });

  it('keeps an empty string rather than turning it into null', () => {
    // Only an absent value is null: an issuer whose empty value is `""` is a
    // different fact from one that said nothing, and callers decide.
    expect(truncatedOrNull('', 40)).toBe('');
  });
});
