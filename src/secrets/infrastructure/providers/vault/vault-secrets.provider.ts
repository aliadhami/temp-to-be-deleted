import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import vaultClient from 'node-vault';
import { SecretsProviderPort } from '../../../domain/secrets-provider.port';

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/** Shape of a KV v2 read response for our single-field {"value": "..."} secrets. */
interface VaultKvV2ReadResult {
  data?: {
    data?: {
      value?: unknown;
    };
  };
}

/** Shape of an AppRole login response — only the fields we use. */
interface VaultAppRoleLoginResult {
  auth?: {
    client_token?: unknown;
    lease_duration?: unknown;
  };
}

@Injectable()
export class VaultSecretsProvider implements SecretsProviderPort, OnModuleInit {
  private readonly logger = new Logger(VaultSecretsProvider.name);

  private client!: ReturnType<typeof vaultClient>;
  private roleIdPath!: string;
  private secretIdPath!: string;
  private mountPath!: string;
  private environment!: string;

  private cachedToken: CachedToken | null = null;
  private static readonly TOKEN_REFRESH_SKEW_MS = 60_000;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const vaultAddr = this.configService.getOrThrow<string>('VAULT_ADDR');
    const caCertPath =
      this.configService.getOrThrow<string>('VAULT_CACERT_PATH');
    this.roleIdPath =
      this.configService.getOrThrow<string>('VAULT_ROLE_ID_FILE');
    this.secretIdPath = this.configService.getOrThrow<string>(
      'VAULT_SECRET_ID_FILE',
    );
    this.mountPath = this.configService.get<string>(
      'VAULT_MOUNT_PATH',
      'blockpay',
    );
    this.environment =
      this.configService.getOrThrow<string>('VAULT_ENVIRONMENT');

    this.client = vaultClient({
      apiVersion: 'v1',
      endpoint: vaultAddr,
      requestOptions: { ca: readFileSync(caCertPath, 'utf8') },
    });
  }

  async getSecret(path: string): Promise<string> {
    const fullPath = `${this.mountPath}/data/${this.environment}/${path}`;
    const token = await this.getValidToken();

    this.client.token = token;
    const response = (await this.client.read(fullPath)) as VaultKvV2ReadResult;

    const value = response.data?.data?.value;
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `Vault secret at "${fullPath}" is missing its "value" field or is empty`,
      );
    }
    return value;
  }

  private async getValidToken(): Promise<string> {
    const now = Date.now();
    if (
      this.cachedToken &&
      this.cachedToken.expiresAtMs -
        VaultSecretsProvider.TOKEN_REFRESH_SKEW_MS >
        now
    ) {
      return this.cachedToken.token;
    }
    return this.login();
  }

  private async login(): Promise<string> {
    const roleId = readFileSync(this.roleIdPath, 'utf8').trim();
    const secretId = readFileSync(this.secretIdPath, 'utf8').trim();

    const result = (await this.client.approleLogin({
      role_id: roleId,
      secret_id: secretId,
    })) as VaultAppRoleLoginResult;

    const token = result.auth?.client_token;
    const leaseSeconds = result.auth?.lease_duration;

    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('Vault AppRole login did not return a client_token');
    }
    if (typeof leaseSeconds !== 'number') {
      throw new Error('Vault AppRole login did not return a lease_duration');
    }

    this.cachedToken = { token, expiresAtMs: Date.now() + leaseSeconds * 1000 };
    this.logger.log('Authenticated to Vault via AppRole');
    return token;
  }
}
