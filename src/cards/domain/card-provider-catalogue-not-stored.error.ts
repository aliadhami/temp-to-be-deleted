import { CardCatalogueRefreshFailedError } from './card-catalogue-refresh-failed.error';
import { CardProviderKey } from './card-provider-key.enum';

/**
 * A provider's catalogue was read but could not be stored — the write phase
 * rolled back, so the previous snapshot is intact and complete.
 */
export class CardProviderCatalogueNotStoredError extends CardCatalogueRefreshFailedError {
  constructor(providerKey: CardProviderKey, options?: ErrorOptions) {
    super(
      providerKey,
      `Card provider "${providerKey}" catalogue could not be stored`,
      options,
    );
    this.name = 'CardProviderCatalogueNotStoredError';
  }
}
