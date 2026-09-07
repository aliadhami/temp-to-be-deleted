import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Agent, request as httpsRequest } from 'node:https';
import { CardProviderKey } from '../../../domain/card-provider-key.enum';
import * as secretsProviderPort from '../../../../secrets/domain/secrets-provider.port';
import { AxysSignatureService } from './axys-signature.service';

export interface AxysResponse<T = unknown> {
  status: number;
  body: T;
}

@Injectable()
export class AxysHttpClient implements OnModuleInit {
  private agent: Agent | null = null;
  private signingKeyPem: string | null = null;
  private baseHost: string | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly signatureService: AxysSignatureService,
    @Inject(secretsProviderPort.SECRETS_PROVIDER)
    private readonly secretsProvider: secretsProviderPort.SecretsProviderPort,
  ) {}

  async onModuleInit(): Promise<void> {
    const enabledProviders = this.configService.get<string[]>(
      'PAYMENTS_ENABLED_CARD_PROVIDERS',
      [],
    );
    // Mirrors the existing "What not to do" rule this class used to violate:
    // a disabled provider must not touch Vault or build a TLS agent at all.
    // A call to `request()` while disabled fails with a clear error instead
    // of this constructor crashing the whole app over secrets a deployment
    // was never given.
    if (!enabledProviders.includes(CardProviderKey.AXYS)) return;

    const [cert, key, signingKeyPem] = await Promise.all([
      this.secretsProvider.getSecret('axys/mtls-chain'),
      this.secretsProvider.getSecret('axys/mtls-private-key'),
      this.secretsProvider.getSecret('axys/request-signing-key'),
    ]);

    this.signingKeyPem = signingKeyPem;

    const rawBaseUrl = this.configService
      .getOrThrow<string>('PAYMENTS_AXYS_BASE_URL')
      .replace(/\/+$/, '');
    this.baseHost = new URL(rawBaseUrl).host;

    this.agent = new Agent({ cert, key, keepAlive: true });
  }

  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT',
    pathWithQuery: string,
    body?: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<AxysResponse<T>> {
    if (!this.agent || !this.signingKeyPem || !this.baseHost) {
      throw new Error(
        'AxysHttpClient.request() was called but Axys is not enabled (PAYMENTS_ENABLED_CARD_PROVIDERS) — this adapter should not be reachable while disabled',
      );
    }

    const rawBody = body ? JSON.stringify(body) : '';
    const signedHeaders = this.signatureService.sign(
      method,
      pathWithQuery,
      rawBody,
      this.signingKeyPem,
    );

    const headers: Record<string, string> = {
      ...signedHeaders,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(rawBody).toString(),
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    return new Promise<AxysResponse<T>>((resolve, reject) => {
      const req = httpsRequest(
        {
          agent: this.agent!,
          host: this.baseHost!,
          method,
          path: pathWithQuery,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed: T | null = null;
            try {
              parsed = raw ? (JSON.parse(raw) as T) : null;
            } catch {
              parsed = null;
            }
            resolve({ status: res.statusCode ?? 0, body: parsed as T });
          });
        },
      );
      req.on('error', (error) => reject(error));
      if (rawBody) req.write(rawBody);
      req.end();
    });
  }
}
