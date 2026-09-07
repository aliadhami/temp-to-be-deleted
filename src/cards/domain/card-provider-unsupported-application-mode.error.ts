import { CardProductApplicationMode } from './card-product-application-mode.enum';
import { CardProviderKey } from './card-provider-key.enum';

/**
 * An adapter refused a product because it does not serve the way that product
 * is applied for — the issuer publishes the mode and we do not call it.
 */
export class CardProviderUnsupportedApplicationModeError extends Error {
  constructor(
    public readonly providerKey: CardProviderKey,
    public readonly applicationMode: string,
    public readonly supportedApplicationModes: readonly CardProductApplicationMode[],
  ) {
    super(
      `Card provider "${providerKey}" does not apply for products in "${applicationMode}" mode; it applies for ${supportedApplicationModes.join(', ')}.`,
    );
    this.name = 'CardProviderUnsupportedApplicationModeError';
  }
}
