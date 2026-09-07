import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { readFileSync } from 'node:fs';
import { Repository } from 'typeorm';
import { GatewayCredentials } from '../../domain/gateway-credentials.model';
import { GatewayKey } from '../../domain/gateway-key.enum';
import { PartnerGatewayCredentialEntity } from '../../../partners/persistence/partner-gateway-credential.entity';
import { CredentialEnvironment } from '../../../partners/domain/credential-environment.enum';
import { CredentialEncryptionService } from '../../../shared/crypto/credential-encryption.service';

export interface ResolveCredentialsInput {
  gatewayKey: GatewayKey;
  partnerId: string | null;
  environment: CredentialEnvironment;
}

@Injectable()
export class CredentialResolver {
  constructor(
    @InjectRepository(PartnerGatewayCredentialEntity)
    private readonly credentialRepository: Repository<PartnerGatewayCredentialEntity>,
    private readonly configService: ConfigService,
    private readonly encryptionService: CredentialEncryptionService,
  ) {}

  async resolve(input: ResolveCredentialsInput): Promise<GatewayCredentials> {
    const globalCredentials = this.resolveFromEnv(input.gatewayKey);

    if (!input.partnerId) return globalCredentials;

    const row = await this.credentialRepository.findOne({
      where: {
        partnerId: input.partnerId,
        gatewayKey: input.gatewayKey,
        environment: input.environment,
      },
    });
    if (!row) return globalCredentials; // no override — use global env credentials

    const decrypted = this.encryptionService.decrypt(row.credentialsEncrypted);
    const partnerOverrides = JSON.parse(decrypted) as GatewayCredentials;

    // Partner-specific merchant secrets override the shared/global config
    // (URLs, ENV, etc. stay global unless the partner blob explicitly sets them).
    return { ...globalCredentials, ...partnerOverrides };
  }

  private resolveFromEnv(gatewayKey: GatewayKey): GatewayCredentials {
    const prefix = `PAYMENTS_${gatewayKey}_`;
    const credentials: Record<string, string> = {};

    // Each adapter's config file declares which keys it needs — the resolver
    // just reads everything under its namespace so adapters stay decoupled
    // from *how* credentials are sourced.
    for (const [envKey, value] of Object.entries(process.env)) {
      if (envKey.startsWith(prefix) && value) {
        const shortKey = envKey.slice(prefix.length);
        if (shortKey.endsWith('_FILE')) {
          const credentialKey = shortKey.slice(0, -'_FILE'.length);
          credentials[credentialKey] = readFileSync(value, 'utf8').trimEnd();
          continue;
        }

        credentials[shortKey] ??= value;
      }
    }
    return credentials;
  }
}
