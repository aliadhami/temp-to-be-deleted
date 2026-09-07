import { KeyObject } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  deriveHyperCardCardDetailPublicKey,
  loadHyperCardCardDetailKey,
} from './hypercard-card-detail.crypto';
import { SECRETS_PROVIDER } from '../../../../secrets/domain/secrets-provider.port';
import type { SecretsProviderPort } from '../../../../secrets/domain/secrets-provider.port';

/** Both halves of the card-detail keypair — one sent, one used to decrypt. */
export interface HyperCardCardDetailKeyPair {
  privateKey: KeyObject;
  /** Base64 DER SubjectPublicKeyInfo, the form their `pub_key` field takes. */
  publicKeyBase64: string;
}

/** Holds the keypair their "Bank card detail-v2" endpoint encrypts under. */
@Injectable()
export class HyperCardCardDetailKeyService {
  private keyPair: HyperCardCardDetailKeyPair | null = null;
  // Guards concurrent first calls from each independently hitting Vault.
  private resolving: Promise<HyperCardCardDetailKeyPair> | null = null;

  constructor(
    @Inject(SECRETS_PROVIDER)
    private readonly secretsProvider: SecretsProviderPort,
  ) {}

  async resolve(): Promise<HyperCardCardDetailKeyPair> {
    if (this.keyPair) return this.keyPair;
    if (this.resolving) return this.resolving;

    this.resolving = this.doResolve()
      .then((resolved) => {
        this.keyPair = resolved;
        this.resolving = null;
        return resolved;
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

  private async doResolve(): Promise<HyperCardCardDetailKeyPair> {
    const pem = await this.secretsProvider.getSecret(
      'hypercard/card-detail-key',
    );
    const privateKey = loadHyperCardCardDetailKey(pem);

    return {
      privateKey,
      // Derived rather than configured beside it: two paths that must agree are
      // a way for them to disagree, and their response echoes the key it used,
      // so the adapter can check ours came back rather than trusting it did.
      publicKeyBase64: deriveHyperCardCardDetailPublicKey(privateKey),
    };
  }
}
