/** The validation patterns every card request that carries money uses. */

/**
 * A positive decimal amount, as a string. Never a `number`: a crypto-funded
 * card program denominates to eight decimal places, past what a JSON number
 * carries faithfully.
 */
export const POSITIVE_DECIMAL_PATTERN = /^(?!0+(\.0+)?$)\d{1,20}(\.\d{1,8})?$/;

/** The same, admitting zero — for a value that is legitimately nothing, such as a fee. */
export const NON_NEGATIVE_DECIMAL_PATTERN = /^\d{1,20}(\.\d{1,8})?$/;

/**
 * A card's own currency, which is always fiat — hence three characters. Stated
 * rather than left to look like an oversight, because a crypto-funded program
 * invites the opposite assumption.
 */
export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
