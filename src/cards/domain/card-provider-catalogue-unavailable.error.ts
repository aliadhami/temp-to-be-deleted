import { CardCatalogueRefreshFailedError } from './card-catalogue-refresh-failed.error';
import { CardProviderKey } from './card-provider-key.enum';

/**
 * A provider's catalogue could not be read this run — `listCardProducts`
 * failed. Lets the read endpoint serve the previous snapshot on a failed
 * refresh rather than a 5xx.
 */
export class CardProviderCatalogueUnavailableError extends CardCatalogueRefreshFailedError {
  constructor(providerKey: CardProviderKey, options?: ErrorOptions) {
    super(
      providerKey,
      `Card provider "${providerKey}" catalogue could not be read`,
      options,
    );
    this.name = 'CardProviderCatalogueUnavailableError';
  }
}
