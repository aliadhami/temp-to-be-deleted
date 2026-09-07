import { CardProviderKey } from './card-provider-key.enum';
export interface ResidentialAddress {
  addressLine1: string;
  city: string;
  /** ISO 3166-1 alpha-2 */
  country: string;
  state?: string;
  zipCode?: string;
}

export interface IdentityProvenance {
  /** Free-text legal nationality as shown on the government ID */
  nationality: string;
  /** ISO 3166-1 alpha-3 */
  placeOfBirth: string;
  /** 0 male, 1 female, 2 unspecified */
  gender: 0 | 1 | 2;
  /** Intl dialing code digits only, no + */
  callingCode: string;
  /** ISO 3166-1 alpha-2 — despite the name, NOT a dial code */
  countryCallingCode: string;
  cellNumber: string;
}

export interface CardholderIntent {
  publicId: string;
  partnerId: string;
  providerKey: CardProviderKey;
  firstName: string;
  lastName: string;
  email: string;
  /** E.164, with leading + */
  phone: string;
  /** ISO-8601 date YYYY-MM-DD */
  dateOfBirth: string;
  residentialAddress: ResidentialAddress;
  identityProvenance: IdentityProvenance;
  /**
   * As the partner observed it. Never the address the request arrived from —
   * that is the partner's backend on a server-to-server route.
   */
  userIp?: string;
}
