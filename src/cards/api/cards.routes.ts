/** The card routes that are named in more than one place. */
export const CARDS_ROUTE_PREFIX = 'cards';

/** Relative to the prefix, as the controller declares it. */
export const CARD_ACTIVATE_ROUTE = ':publicId/activate';

/** Absolute, as Express matches it. */
export const CARD_ACTIVATE_PATH = `/${CARDS_ROUTE_PREFIX}/${CARD_ACTIVATE_ROUTE}`;
