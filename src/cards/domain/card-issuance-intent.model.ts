import { CardProductApplicationMode } from './card-product-application-mode.enum';
import { CardProviderKey } from './card-provider-key.enum';
import { CardType } from './card-type.enum';

/**
 * The person a card is being opened for, from the stored cardholder row. It
 * rides the issuance intent because some issuers open the person and the card
 * in one call; an issuer that created the person earlier ignores it.
 */
export interface CardApplicantDetails {
  firstName: string;
  lastName: string;
  email: string;
  /** Intl dialling code digits only, no `+`. */
  callingCode: string;
  cellNumber: string;
  /** As observed at onboarding. Absent is ordinary. */
  userIp?: string;
}

/**
 * Which catalogue product this card is opened against. Absent for an issuer
 * with no product concept.
 */
export interface CardProductReference {
  providerProductId: string;
  applicationMode: CardProductApplicationMode;
}

/**
 * How long a name printed on a card may be. Mirrors `card.name_on_card`'s
 * column width; lives in `domain/` so the DTO and the use case can both read it.
 */
export const NAME_ON_CARD_MAX_LENGTH = 150;

export interface CardIssuanceIntent {
  /**
   * The card row's own public id, and the reference this application is
   * addressed by — never the cardholder's. A canonical UUID: an adapter may
   * derive its wire form from this, and that derivation is only collision-free
   * for a canonical UUID.
   */
  publicId: string;
  cardholderPublicId: string;
  providerKey: CardProviderKey;
  cardType: CardType;
  nameOnCard: string;
  //currency: string;
  applicant: CardApplicantDetails;
  cardProduct?: CardProductReference;
  /**
   * The opening deposit, in the resolved product's currency. Decimal string,
   * never a JS `number`. Absent means none was committed, which is not zero.
   */
  initialDepositAmount?: string;
}

/**
 * What one issuer needs to turn an opened card into a usable one. Everything
 * but the card's identifiers is optional — issuers activate by fundamentally
 * different means, and a required union would demand values half of them
 * cannot use.
 */
export interface CardActivationIntent {
  cardPublicId: string;
  providerCardId: string;
  /** The number printed on a card the cardholder is holding. */
  pan?: string;
  expiryMonth?: number;
  expiryYear?: number;
  cvv?: string;
  pin?: string;
  /**
   * A photograph of the cardholder with their identity document and the card,
   * base64-encoded. Raw base64, no `data:` URI prefix — refused at the DTO,
   * because at least one issuer rejects a prefixed value with the same message
   * a corrupt file gets.
   */
  activationDocument?: string;
}
