import { CardProviderKey } from './card-provider-key.enum';

/**
 * A provider was asked for something it has no concept of — not something we
 * have not built yet, and not a call that was made and failed. Nothing should
 * reach this: every such operation is gated by a `CardCapability` at its call
 * site.
 */
export class CardProviderUnsupportedOperationError extends Error {
  constructor(
    public readonly providerKey: CardProviderKey,
    public readonly operation: string,
    public readonly reason: string,
  ) {
    super(
      `Card provider "${providerKey}" does not support ${operation}: ${reason}.`,
    );
    this.name = 'CardProviderUnsupportedOperationError';
  }
}
