import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HyperCardSignatureService } from './hypercard-signature.service';
import {
  assertHyperCardSuccess,
  HyperCardApiError,
  unwrapHyperCardData,
} from './hypercard-response.util';
import { HyperCardEnvelope } from './hypercard.types';
import * as secretsProviderPort from '../../../../secrets/domain/secrets-provider.port';

const REQUEST_TIMEOUT_MS = 20_000;

const TRANSPORT_ERROR_CODE = 'TRANSPORT_ERROR';

interface ResolvedHyperCardConfig {
  baseUrl: string;
  apiKey: string;
  signingKeyPem: string;
}

interface RawHyperCardResponse<T> {
  status: number;
  envelope: HyperCardEnvelope<T> | null;
}

@Injectable()
export class HyperCardHttpClient {
  private config: ResolvedHyperCardConfig | null = null;
  // Guards concurrent first calls from each independently resolving config
  // (and each independently calling Vault) — same race we saw with Axys.
  private resolvingConfig: Promise<ResolvedHyperCardConfig> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly signatureService: HyperCardSignatureService,
    @Inject(secretsProviderPort.SECRETS_PROVIDER)
    private readonly secretsProvider: secretsProviderPort.SecretsProviderPort,
  ) {}

  async post<T>(
    operation: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const { status, envelope } = await this.send<T>(operation, path, body);
    return unwrapHyperCardData(operation, status, envelope);
  }

  async postForOptionalData<T>(
    operation: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<T | null> {
    const { status, envelope } = await this.send<T>(operation, path, body);
    assertHyperCardSuccess(operation, status, envelope);
    return envelope.data ?? null;
  }

  async postForAck(
    operation: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const { status, envelope } = await this.send<never>(operation, path, body);
    assertHyperCardSuccess(operation, status, envelope);
  }

  private async send<T>(
    operation: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<RawHyperCardResponse<T>> {
    const { baseUrl, apiKey, signingKeyPem } = await this.resolveConfig();

    const rawBody = JSON.stringify(body);
    const signedHeaders = this.signatureService.sign(
      body,
      { apiKey },
      signingKeyPem,
    );

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          ...signedHeaders,
          'Content-Type': 'application/json',
        },
        body: rawBody,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new HyperCardApiError(
        0,
        TRANSPORT_ERROR_CODE,
        `HyperCard ${operation} could not reach ${path}: ${reason}`,
      );
    }

    const raw = await response.text();
    let envelope: HyperCardEnvelope<T> | null = null;
    try {
      envelope = raw ? (JSON.parse(raw) as HyperCardEnvelope<T>) : null;
    } catch {
      envelope = null;
    }

    return { status: response.status, envelope };
  }

  /**
   * Resolves config and fetches the signing key from Vault on first use,
   * then caches both. Concurrent first calls share one in-flight resolution
   * rather than each independently hitting Vault.
   */
  private resolveConfig(): Promise<ResolvedHyperCardConfig> {
    if (this.config) return Promise.resolve(this.config);
    if (this.resolvingConfig) return this.resolvingConfig;

    this.resolvingConfig = this.doResolveConfig()
      .then((resolved) => {
        this.config = resolved;
        this.resolvingConfig = null;
        return resolved;
      })
      .catch((error) => {
        // A failed resolution must not be cached — the next call has to
        // retry cleanly once the missing config/secret is available,
        // rather than replaying the same rejection forever.
        this.resolvingConfig = null;
        throw error;
      });
    return this.resolvingConfig;
  }

  private async doResolveConfig(): Promise<ResolvedHyperCardConfig> {
    const baseUrl = this.configService
      .getOrThrow<string>('PAYMENTS_HYPERCARD_BASE_URL')
      .replace(/\/+$/, '');

    const [apiKey, signingKeyPem] = await Promise.all([
      this.secretsProvider.getSecret('hypercard/api-key'),
      this.secretsProvider.getSecret('hypercard/signing-key'),
    ]);

    return { baseUrl, apiKey, signingKeyPem };
  }
}
