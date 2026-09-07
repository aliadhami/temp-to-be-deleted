import { CardProviderKey } from './card-provider-key.enum';

/**
 * A provider refused an operation because it allows one in a window and this
 * card's has been used. **The issuer rate-limiting us, never `ThrottlerGuard`.**
 *
 * Distinct from `CardProviderConflictError`: only waiting clears this one.
 */
export class CardProviderThrottledError extends Error {
  constructor(
    public readonly providerKey: CardProviderKey,
    public readonly providerCode: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CardProviderThrottledError';
  }
}
