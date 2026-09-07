import { Inject, Injectable } from '@nestjs/common';
import { SECRETS_PROVIDER } from '../../../../secrets/domain/secrets-provider.port';
import type { SecretsProviderPort } from '../../../../secrets/domain/secrets-provider.port';

/**
 * Holds HyperCard's own public key, which their callbacks are signed with.
 * **Not our signing keypair** — that one proves a request came from us.
 *
 * Read on first use, never at boot, so a deployment not running this issuer
 * still starts.
 */
@Injectable()
export class HyperCardPlatformKeyService {
  private publicKeyPem: string | null = null;
  // Guards concurrent first callbacks from each independently hitting Vault.
  private resolving: Promise<string> | null = null;

  constructor(
    @Inject(SECRETS_PROVIDER)
    private readonly secretsProvider: SecretsProviderPort,
  ) {}

  async resolve(): Promise<string> {
    if (this.publicKeyPem !== null) return this.publicKeyPem;
    if (this.resolving) return this.resolving;

    this.resolving = this.secretsProvider
      .getSecret('hypercard/platform-public')
      .then((pem) => {
        this.publicKeyPem = pem;
        this.resolving = null;
        return pem;
      })
      .catch((error) => {
        // Same reasoning as HyperCardHttpClient: a failed resolution must not
        // be cached, or a transient Vault outage becomes a permanent one for
        // the life of the process.
        this.resolving = null;
        throw error;
      });
    return this.resolving;
  }
}
