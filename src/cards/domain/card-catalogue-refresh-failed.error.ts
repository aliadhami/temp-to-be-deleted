import { CardProviderKey } from './card-provider-key.enum';

/** A refresh of a provider's card catalogue did not produce a new snapshot. */
export abstract class CardCatalogueRefreshFailedError extends Error {
  protected constructor(
    public readonly providerKey: CardProviderKey,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
