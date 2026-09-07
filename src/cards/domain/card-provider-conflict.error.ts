import { CardProviderKey } from './card-provider-key.enum';

/**
 * A provider refused an operation because the card or cardholder is not in a
 * state that permits it — activating a cancelled card, revealing details on a
 * closed one.
 */
export class CardProviderConflictError extends Error {
  constructor(
    public readonly providerKey: CardProviderKey,
    public readonly providerCode: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CardProviderConflictError';
  }
}
