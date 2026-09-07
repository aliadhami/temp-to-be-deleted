import { Global, Module } from '@nestjs/common';
import { SECRETS_PROVIDER } from './domain/secrets-provider.port';
import { VaultSecretsProvider } from './infrastructure/providers/vault/vault-secrets.provider';

/**
 * Global: every provider adapter (Axys, MLT, future KlicklPay) needs secrets,
 * and none of them should each re-import this module individually.
 */
@Global()
@Module({
  providers: [
    VaultSecretsProvider,
    { provide: SECRETS_PROVIDER, useExisting: VaultSecretsProvider },
  ],
  exports: [SECRETS_PROVIDER],
})
export class SecretsModule {}
