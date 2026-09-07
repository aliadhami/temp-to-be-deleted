import { CardLifecycleOperation } from './card-lifecycle-operation.enum';
import { CardMaterial } from './card-material.enum';
import { CardOrganisation } from './card-organisation.enum';
import { CardProductActivationMode } from './card-product-activation-mode.enum';
import { CardProductApplicationMode } from './card-product-application-mode.enum';
import { CardProductSensitiveDetailMode } from './card-product-sensitive-detail-mode.enum';
import { CardType } from './card-type.enum';

/**
 * A currency or coin code, uppercased. Not always ISO 4217. **Uppercasing is
 * the adapter's job** — issuers publish these in any case.
 */
export type CurrencyOrCoinCode = string;

/**
 * A single fee. It carries its own currency: an issuer does not necessarily
 * bill every fee in the card's currency.
 */
export interface CardProductFee {
  /** A decimal string, never a JS `number`. */
  amount: string;
  /** What this particular fee is billed in. Need not be the card's currency. */
  currencyCode: CurrencyOrCoinCode;
}

export interface CardProductFees {
  /** One-off fee to open a card. Null when the issuer charges none. */
  issuance: CardProductFee | null;
  /** Recurring fee to keep a card open. Null when the issuer charges none. */
  annual: CardProductFee | null;
  /** A decimal string, never a JS `number`. */
  depositFeePercent: string | null;
}

/**
 * Deposit fee **in percent units** — `'2.800'` is 2.8%, never `'0.028'`.
 * Decimal string. Null when free.
 */
export interface CardProductDepositLimits {
  minPerTransaction: string | null;
  maxPerTransaction: string | null;
  maxPerDay: string | null;

  /**
   * Deposit limits. Decimal strings in the product's `currencyCode`. Null means
   * the issuer states no limit, which is not a limit of zero. Not spending limits.
   */
  requiresInitialDeposit: boolean;
  /** The mandated minimum, when the issuer states one. */
  minInitialDeposit: string | null;
}

/** Separate from the amount below: an issuer can mandate one with no minimum. */
export type CardProductActivation =
  | { mode: CardProductActivationMode.CARDHOLDER_DIRECT }
  | {
      mode: CardProductActivationMode.ISSUER_REQUEST;
      /** The activation call has to carry an identity document. */
      requiresIdentityDocument: boolean;
    };

/**
 * A card product a provider offers — one catalogue row, normalised. Carries
 * the product's meaning, never an issuer's codes.
 */
export interface CardProduct {
  /**
   * The provider's own stable handle — keys persistence and lookups, and is
   * never part of an API response. A partner refers to a product by `public_id`.
   */
  providerProductId: string;

  /** An issuer publishing no name has one composed in its adapter. */
  displayName: string;

  cardType: CardType;
  cardOrganisation: CardOrganisation;

  /** Null means the issuer publishes no material — read `cardType` for virtual. */
  material: CardMaterial | null;

  /** The currency the card itself is denominated in. */
  currencyCode: CurrencyOrCoinCode;

  fees: CardProductFees;
  depositLimits: CardProductDepositLimits;

  /** Decides which application path runs; finer than `requiresKyc` below. */
  applicationMode: CardProductApplicationMode;

  /**
   * Kept alongside `applicationMode` rather than derived — an issuer with no
   * mode concept still answers it. The adapter keeps the two consistent.
   */
  requiresKyc: boolean;

  activation: CardProductActivation;

  /**
   * What a partner gets when reading this card's number, security code and
   * expiry. Null means the issuer publishes nothing readable, not that the
   * card cannot be read — an unfamiliar value still lists and still issues.
   */
  sensitiveDetailMode: CardProductSensitiveDetailMode | null;

  /** False means new applications are refused; the product stays resolvable. */
  availableForIssuance: boolean;

  /**
   * Which operations the issuer offers against a card issued against this
   * product. Empty means none; never null, so "offers none" cannot be read as
   * "not known". Not `CardCapability`, which says what the *issuer* can do
   * where this says what *this product* offers.
   */
  supportedOperations: readonly CardLifecycleOperation[];
}
