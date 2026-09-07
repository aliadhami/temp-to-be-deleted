/**
 * Reads named secrets from wherever they're actually stored. The only
 * implementation is Vault-backed — there is no filesystem or env-var
 * fallback, by design: a provider adapter that can't reach its secrets
 * must fail to start, not silently degrade.
 */
export interface SecretsProviderPort {
  /**
   * Fetches a single secret's raw string value.
   * @param path Environment-relative path, e.g. "axys/mtls-private-key" —
   *             the caller never specifies "dev" or "prod"; the adapter
   *             resolves that from its own configured environment.
   * @throws if the secret does not exist or cannot be read.
   */
  getSecret(path: string): Promise<string>;
}

export const SECRETS_PROVIDER = Symbol('SECRETS_PROVIDER');
