import { CardProviderKey } from './card-provider-key.enum';

/**
 * An adapter refused an intent before sending it, because a field does not
 * meet its provider's documented requirements.
 */
export class CardProviderIntentRejectedError extends Error {
  constructor(
    public readonly providerKey: CardProviderKey,
    public readonly field: string,
    public readonly reason: string,
    /**
     * For when the provider's own answer identified the field. Their wire text
     * is not republished in `message`; carrying it as `cause` keeps it
     * reachable for a log without putting it in a response body.
     */
    options?: ErrorOptions,
  ) {
    super(
      `Card provider "${providerKey}" cannot accept "${field}": ${reason}.`,
      options,
    );
    this.name = 'CardProviderIntentRejectedError';
  }

  /**
   * The same refusal under the field a caller actually received. An adapter
   * reachable from more than one route cannot know which one a partner sent.
   */
  namedFor(field: string): CardProviderIntentRejectedError {
    return new CardProviderIntentRejectedError(
      this.providerKey,
      field,
      this.reason,
      { cause: this.cause },
    );
  }
}
