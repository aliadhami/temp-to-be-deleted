/**
 * How a cardholder acquires a card issued against this product. The *meaning*
 * of an issuer's application setting, never its encoding — an issuer's own
 * numbering stays inside its adapter folder.
 */
export enum CardProductApplicationMode {
  /** Identity details only, no documents. */
  NO_KYC = 'NO_KYC',

  /** Apply with identity documents supplied inline with the application. */
  FULL_KYC = 'FULL_KYC',

  /**
   * A card the holder already physically has is linked to them, rather than
   * minted. Identity documents follow as a second call.
   */
  PREISSUED_CARD = 'PREISSUED_CARD',

  /** Documents inline, plus a billing address. **Inferred** — see above. */
  KYC_WITH_BILLING_ADDRESS = 'KYC_WITH_BILLING_ADDRESS',

  /**
   * **Inferred**, and the least certain of the five — its request payload is
   * structurally indistinguishable from the plain documents-inline mode.
   */
  ONLINE_KYC = 'ONLINE_KYC',
}
