import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { Repository } from 'typeorm';
import { ApiKeyScope } from '../domain/api-key-scope.enum';
import {
  PartnerApiKeyEntity,
  PartnerApiKeyStatus,
} from '../persistence/partner-api-key.entity';
import { PartnerEntity } from '../persistence/partner.entity';

const KEY_ID_PREFIX = 'pk_';
const KEY_ID_BYTES = 6;
const SECRET_BYTES = 32;

const hashSecret = (secret: string): string =>
  createHash('sha256').update(secret, 'utf8').digest('hex');

export interface VerifiedApiKey {
  partnerId: string;
  partnerPublicId: string;
  scopes: ApiKeyScope[];
}

@Injectable()
export class PartnerApiKeyService {
  constructor(
    @InjectRepository(PartnerApiKeyEntity)
    private readonly apiKeyRepository: Repository<PartnerApiKeyEntity>,
    @InjectRepository(PartnerEntity)
    private readonly partnerRepository: Repository<PartnerEntity>,
  ) {}

  async create(partnerPublicId: string, scopes: ApiKeyScope[], label?: string) {
    const partner = await this.partnerRepository.findOne({
      where: { publicId: partnerPublicId },
    });
    if (!partner) throw new NotFoundException('Partner not found');

    return this.createRow(partner.id, scopes, label);
  }

  async createForPartnerId(
    partnerId: string,
    scopes: ApiKeyScope[],
    label?: string,
  ) {
    return this.createRow(partnerId, scopes, label);
  }

  private async createRow(
    partnerId: string,
    scopes: ApiKeyScope[],
    label?: string,
  ) {
    const keyId = KEY_ID_PREFIX + randomBytes(KEY_ID_BYTES).toString('hex');
    const secret = randomBytes(SECRET_BYTES).toString('hex');

    const row = this.apiKeyRepository.create({
      partnerId,
      keyId,
      secretHash: hashSecret(secret),
      label: label ?? null,
      status: PartnerApiKeyStatus.ACTIVE,
      scopes,
    });
    await this.apiKeyRepository.save(row);

    // The only place the plaintext secret ever exists — never stored, never logged
    return { apiKey: `${keyId}.${secret}` };
  }

  async revoke(
    partnerPublicId: string,
    keyId: string,
  ): Promise<{ status: 'revoked' }> {
    const partner = await this.partnerRepository.findOne({
      where: { publicId: partnerPublicId },
    });
    if (!partner) throw new NotFoundException('Partner not found');
    return this.revokeRow(keyId, partner.id);
  }

  async revokeForPartnerId(
    partnerId: string,
    keyId: string,
  ): Promise<{ status: 'revoked' }> {
    return this.revokeRow(keyId, partnerId);
  }

  private async revokeRow(
    keyId: string,
    partnerId: string,
  ): Promise<{ status: 'revoked' }> {
    const row = await this.apiKeyRepository.findOne({
      where: { keyId, partnerId },
    });
    if (!row) throw new NotFoundException('API key not found');

    row.status = PartnerApiKeyStatus.REVOKED;
    await this.apiKeyRepository.save(row);
    return { status: 'revoked' };
  }

  async list(partnerPublicId: string) {
    const partner = await this.partnerRepository.findOne({
      where: { publicId: partnerPublicId },
    });
    if (!partner) throw new NotFoundException('Partner not found');
    return this.listRows(partner.id);
  }

  async listForPartnerId(partnerId: string) {
    return this.listRows(partnerId);
  }

  private async listRows(partnerId: string) {
    const rows = await this.apiKeyRepository.find({
      where: { partnerId },
      order: { createdAt: 'DESC' },
    });
    // Never return keyId+secret together, never return the hash
    return rows.map((row) => ({
      keyId: row.keyId,
      label: row.label,
      status: row.status,
      scopes: row.scopes,
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
    }));
  }

  /** Used by the auth guard — verifies a presented `keyId.secret` and resolves the partner + scopes. */
  async verify(presentedApiKey: string): Promise<VerifiedApiKey | null> {
    const separatorIndex = presentedApiKey.indexOf('.');
    if (separatorIndex === -1) return null;

    const keyId = presentedApiKey.slice(0, separatorIndex);
    const secret = presentedApiKey.slice(separatorIndex + 1);

    const row = await this.apiKeyRepository.findOne({
      where: { keyId, status: PartnerApiKeyStatus.ACTIVE },
      relations: { partner: true },
    });
    if (!row || !row.partner) return null;

    const providedHash = Buffer.from(hashSecret(secret), 'utf8');
    const storedHash = Buffer.from(row.secretHash, 'utf8');
    if (providedHash.length !== storedHash.length) return null;
    if (!timingSafeEqual(providedHash, storedHash)) return null;

    row.lastUsedAt = new Date();
    await this.apiKeyRepository.save(row);

    return {
      partnerId: row.partnerId,
      partnerPublicId: row.partner.publicId,
      scopes: row.scopes,
    };
  }
}
