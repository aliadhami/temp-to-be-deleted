import { Logger } from '@nestjs/common';
import {
  RevealedCardDetail,
  SensitiveCardDetails,
} from '../../../domain/sensitive-card-details';
import { HYPERCARD_CARD_DETAIL_PADDING_NOTE } from './hypercard-card-detail.crypto';
import { normaliseHyperCardInteger } from './hypercard-coercion.util';
import {
  HyperCardCardDetailData,
  HyperCardCardDetailObtainWay,
  HyperCardCardDetailPlaintext,
  HyperCardCardType,
} from './hypercard.types';

const logger = new Logger('HyperCardCardDetailMapper');

/**
 * Their "Bank card detail-v2" answer could not be turned into a card detail.
 * Adapter-local and deliberately not a domain error — every case is a gap of
 * ours, so there is nothing for a partner to fix.
 */
export class HyperCardCardDetailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HyperCardCardDetailError';
  }
}

/** The digit-count range ISO/IEC 7812 allows a PAN. */
const PAN_PATTERN = /^\d{12,19}$/;

/** Their published expiry form, `04/2025`. */
const EXPIRE_PATTERN = /^(\d{2})\/(\d{4})$/;

/** How many leading digits their own masked numbers keep, e.g. `624673******6680`. */
const MASK_LEADING_DIGITS = 6;
/** And how many trailing ones. */
const MASK_TRAILING_DIGITS = 4;

/**
 * The masked form of a full number, in the issuer's own style. Derived rather
 * than requested: their endpoint returns the complete PAN and no masked one,
 * and the masked form is the half that can be derived.
 */
const maskPan = (pan: string): string =>
  `${pan.slice(0, MASK_LEADING_DIGITS)}${'*'.repeat(
    pan.length - MASK_LEADING_DIGITS - MASK_TRAILING_DIGITS,
  )}${pan.slice(-MASK_TRAILING_DIGITS)}`;

/**
 * One text field of their plaintext, trimmed — refusing anything not a string.
 * A number is refused rather than stringified, the opposite of this folder's
 * coercion util.
 */
const requireText = (raw: unknown, field: string): string => {
  if (typeof raw === 'number') {
    throw new HyperCardCardDetailError(
      `HyperCard returned a card detail whose "${field}" is a JSON number rather than a string. A card field cannot survive that — a leading zero is lost and a long number exceeds double precision — so it is refused rather than read.`,
    );
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new HyperCardCardDetailError(
      `HyperCard returned a card detail with no "${field}"`,
    );
  }
  return raw.trim();
};

/**
 * The same, for an optional field. Separate from the helper above rather than
 * one nullable version, because a missing `url` is a broken response while a
 * missing `password` is their documented ordinary case.
 */
const optionalText = (raw: unknown, field: string): string | undefined =>
  raw === undefined || raw === null ? undefined : requireText(raw, field);

/**
 * Their `card_number`, refused unless it is one. The message names the length
 * and never the value — a partial card number in a log is still a card number.
 */
const requirePan = (raw: unknown): string => {
  const text = requireText(raw, 'card_number');
  if (!PAN_PATTERN.test(text)) {
    throw new HyperCardCardDetailError(
      `HyperCard returned a card detail whose card number is not a 12–19 digit number (${text.length} character(s))`,
    );
  }
  return text;
};

/**
 * Their `expire` as a month and a year. An explicit branch for a shape they
 * have not published, rather than a parse letting `NaN` reach a response: an
 * expiry a partner cannot use is worse than a refusal.
 */
const parseExpiry = (raw: unknown): { month: number; year: number } => {
  // Through the shared guard first, so an absent or numeric expiry is refused by
  // the reason it actually failed rather than by failing to match a pattern.
  const match = EXPIRE_PATTERN.exec(requireText(raw, 'expire'));
  if (!match) {
    throw new HyperCardCardDetailError(
      'HyperCard returned a card detail whose "expire" is not their published MM/YYYY form',
    );
  }

  const month = Number(match[1]);
  const year = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new HyperCardCardDetailError(
      'HyperCard returned a card detail whose "expire" names no calendar month',
    );
  }

  return { month, year };
};

/**
 * When a hosted page stops working, as an ISO 8601 instant. One field rather
 * than their two: the absolute `expires_at` is preferred, and `expires_in` is
 * resolved against our own clock when it is all they sent.
 */
const resolvePageExpiry = (
  plaintext: HyperCardCardDetailPlaintext,
): string | undefined => {
  const expiresAt = normaliseHyperCardInteger(plaintext.expires_at);
  const expiresIn = normaliseHyperCardInteger(plaintext.expires_in);

  const epochSeconds =
    expiresAt !== null && expiresAt > 0
      ? expiresAt
      : expiresIn !== null && expiresIn > 0
        ? Math.floor(Date.now() / 1000) + expiresIn
        : null;

  if (epochSeconds === null) {
    if (
      plaintext.expires_at !== undefined ||
      plaintext.expires_in !== undefined
    ) {
      logger.warn(
        'HyperCard returned a card-detail page whose expiry could not be read — reporting the page without one',
      );
    }
    return undefined;
  }

  const at = new Date(epochSeconds * 1000);
  if (Number.isNaN(at.getTime())) {
    logger.warn(
      'HyperCard returned a card-detail page whose expiry is not a representable instant — reporting the page without one',
    );
    return undefined;
  }

  return at.toISOString();
};

const parsePlaintext = (plaintext: string): HyperCardCardDetailPlaintext => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    // The parse error is deliberately discarded rather than kept as a cause —
    // `JSON.parse` quotes its input into its own message, and that input is
    // the decrypted card detail.
    throw new HyperCardCardDetailError(
      `HyperCard returned a card detail that decrypted to something other than JSON. ${HYPERCARD_CARD_DETAIL_PADDING_NOTE}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HyperCardCardDetailError(
      'HyperCard returned a card detail that decrypted to JSON but not to an object',
    );
  }

  return parsed as HyperCardCardDetailPlaintext;
};

/**
 * Their detail response and its decrypted payload, as one arm of the port's
 * card-detail union.
 */
export const mapHyperCardCardDetail = (
  data: HyperCardCardDetailData,
  decrypted: string,
): SensitiveCardDetails => {
  const plaintext = parsePlaintext(decrypted);
  const obtainWay = normaliseHyperCardInteger(data.card_detail_obtain_way);
  const cardType = normaliseHyperCardInteger(data.card_type);

  return new SensitiveCardDetails(buildDetail(plaintext, obtainWay, cardType));
};

const buildDetail = (
  plaintext: HyperCardCardDetailPlaintext,
  obtainWay: number | null,
  cardType: number | null,
): RevealedCardDetail => {
  switch (obtainWay) {
    case HyperCardCardDetailObtainWay.API:
      return buildApiDetail(plaintext, cardType);

    case HyperCardCardDetailObtainWay.HOSTED_PAGE: {
      // No card data at all — the card type is irrelevant here and is not read.
      const expiresAt = resolvePageExpiry(plaintext);
      // Through the same guard as every other text field. It used to be a bare
      // `?.trim()`, which optional chaining makes look safe and does not: the
      // value comes from `JSON.parse` and a numeric password threw a TypeError
      // rather than refusing.
      const password = optionalText(plaintext.password, 'password');
      return {
        kind: 'HOSTED_PAGE',
        url: requireText(plaintext.url, 'url'),
        // Conditional spreads: under `exactOptionalPropertyTypes` an absent
        // optional cannot be set to undefined, and both of these are optional
        // on their own page.
        ...(password && { password }),
        ...(expiresAt && { expiresAt }),
      };
    }

    case HyperCardCardDetailObtainWay.EMAIL: {
      // **`cvv` and `expire` are deliberately not read** — on this obtain way
      // they carry literal prose, and this arm exists so that text can never be
      // published as a security code. The card type is not branched on: the
      // secrets go to the cardholder either way.
      const pan = requirePan(plaintext.card_number);
      return { kind: 'CARDHOLDER_DIRECT', pan, maskedPan: maskPan(pan) };
    }

    default:
      // **Refused, not guessed.** Their pages document three; a fourth
      // arriving means we do not know what the bytes we decrypted are, and
      // there is no arm to put them in. Naming the value is what turns this
      // from a mystery into a five-minute change.
      throw new HyperCardCardDetailError(
        `HyperCard returned a card detail with an unrecognised card_detail_obtain_way "${String(obtainWay)}" — their pages document 0 (API), 1 (hosted page) and 2 (issuer delivers to the cardholder)`,
      );
  }
};

/**
 * Their API obtain way, whose payload depends on the card's form factor: a
 * virtual card carries the whole set, a physical one carries the number alone.
 */
const buildApiDetail = (
  plaintext: HyperCardCardDetailPlaintext,
  cardType: number | null,
): RevealedCardDetail => {
  if (cardType === HyperCardCardType.VIRTUAL) {
    const pan = requirePan(plaintext.card_number);
    const expiry = parseExpiry(plaintext.expire);
    return {
      kind: 'FULL',
      pan,
      maskedPan: maskPan(pan),
      cvv: requireText(plaintext.cvv, 'cvv'),
      expiryMonth: expiry.month,
      expiryYear: expiry.year,
    };
  }

  if (cardType === HyperCardCardType.PHYSICAL) {
    // Mapping this payload is **not** implementing physical issuance, which no
    // adapter in this codebase has built. It is here because a card type is a
    // property of the product, and reading a card is not the same operation as
    // opening one.
    const pan = requirePan(plaintext.card_number);
    return { kind: 'NUMBER_ONLY', pan, maskedPan: maskPan(pan) };
  }

  // Two payloads differ by exactly this value, so an unfamiliar one leaves no
  // way to tell whether the absence of a security code is the answer or a gap.
  throw new HyperCardCardDetailError(
    `HyperCard returned a card detail with an unrecognised card_type "${String(cardType)}" — their pages document 1 (virtual) and 2 (physical), and the two carry different payloads`,
  );
};
