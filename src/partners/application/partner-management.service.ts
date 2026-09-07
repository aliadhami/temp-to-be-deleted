import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GatewayKey } from '../../payments/domain/gateway-key.enum';
import { CredentialEncryptionService } from '../../shared/crypto/credential-encryption.service';
import { generateWebhookSecret } from '../../shared/webhooks/webhook-secret.util';
import { CredentialEnvironment } from '../domain/credential-environment.enum';
import { PartnerStatus } from '../domain/partner-status.enum';
import { PartnerGatewayCredentialEntity } from '../persistence/partner-gateway-credential.entity';
import { PartnerEntity } from '../persistence/partner.entity';

export interface CreatePartnerInput {
  name: string;
  allowedGateways: string[];
  allowedCurrencies: string[];
  allowedMethods: string[];
  feePercent?: string;
  feeFlat?: string;
  checkoutReturnUrl?: string; // <-- ADDED THIS
}

export type UpdatePartnerInput = Partial<CreatePartnerInput> & {
  status?: PartnerStatus;
};

const toPartnerResponse = (partner: PartnerEntity) => ({
  publicId: partner.publicId,
  name: partner.name,
  status: partner.status,
  allowedGateways: partner.allowedGateways,
  allowedCurrencies: partner.allowedCurrencies,
  allowedMethods: partner.allowedMethods,
  feePercent: partner.feePercent,
  feeFlat: partner.feeFlat,
  webhookUrl: partner.webhookUrl,
  checkoutReturnUrl: partner.checkoutReturnUrl, // <-- ADDED THIS
  createdAt: partner.createdAt,
});

@Injectable()
export class PartnerManagementService {
  constructor(
    @InjectRepository(PartnerEntity)
    private readonly partnerRepository: Repository<PartnerEntity>,
    @InjectRepository(PartnerGatewayCredentialEntity)
    private readonly credentialRepository: Repository<PartnerGatewayCredentialEntity>,
    private readonly encryptionService: CredentialEncryptionService,
  ) {}

  async create(input: CreatePartnerInput) {
    const partner = this.partnerRepository.create({
      name: input.name,
      status: PartnerStatus.ACTIVE,
      allowedGateways: input.allowedGateways,
      allowedCurrencies: input.allowedCurrencies,
      allowedMethods: input.allowedMethods,
      feePercent: input.feePercent ?? null,
      feeFlat: input.feeFlat ?? null,
      webhookUrl: null,
      webhookSecretEncrypted: null,
      checkoutReturnUrl: input.checkoutReturnUrl ?? null, // <-- ADDED THIS
    });
    const saved = await this.partnerRepository.save(partner);
    return toPartnerResponse(saved);
  }

  async list() {
    const partners = await this.partnerRepository.find({
      order: { createdAt: 'DESC' },
    });
    return partners.map(toPartnerResponse);
  }

  async getByPublicId(publicId: string) {
    const partner = await this.findByPublicIdOrThrow(publicId);
    return toPartnerResponse(partner);
  }

  async update(publicId: string, input: UpdatePartnerInput) {
    const partner = await this.findByPublicIdOrThrow(publicId);

    if (input.name !== undefined) partner.name = input.name;
    if (input.status !== undefined) partner.status = input.status;
    if (input.allowedGateways !== undefined)
      partner.allowedGateways = input.allowedGateways;
    if (input.allowedCurrencies !== undefined)
      partner.allowedCurrencies = input.allowedCurrencies;
    if (input.allowedMethods !== undefined)
      partner.allowedMethods = input.allowedMethods;
    if (input.feePercent !== undefined) partner.feePercent = input.feePercent;
    if (input.feeFlat !== undefined) partner.feeFlat = input.feeFlat;

    // <-- ADDED THIS
    if (input.checkoutReturnUrl !== undefined) {
      partner.checkoutReturnUrl = input.checkoutReturnUrl;
    }

    const saved = await this.partnerRepository.save(partner);
    return toPartnerResponse(saved);
  }

  async setCredentials(
    publicId: string,
    gatewayKey: GatewayKey,
    environment: CredentialEnvironment,
    credentials: Record<string, string>,
  ): Promise<{ status: 'stored' }> {
    const partner = await this.findByPublicIdOrThrow(publicId);
    const encrypted = this.encryptionService.encrypt(
      JSON.stringify(credentials),
    );

    const existing = await this.credentialRepository.findOne({
      where: { partnerId: partner.id, gatewayKey, environment },
    });

    if (existing) {
      existing.credentialsEncrypted = encrypted;
      await this.credentialRepository.save(existing);
    } else {
      const row = this.credentialRepository.create({
        partnerId: partner.id,
        gatewayKey,
        environment,
        credentialsEncrypted: encrypted,
      });
      await this.credentialRepository.save(row);
    }

    return { status: 'stored' };
  }

  async setWebhook(
    publicId: string,
    webhookUrl: string,
  ): Promise<{ webhookSecret: string }> {
    const partner = await this.findByPublicIdOrThrow(publicId);
    const secret = generateWebhookSecret();

    partner.webhookUrl = webhookUrl;
    partner.webhookSecretEncrypted = this.encryptionService.encrypt(secret);
    await this.partnerRepository.save(partner);

    return { webhookSecret: secret };
  }

  private async findByPublicIdOrThrow(
    publicId: string,
  ): Promise<PartnerEntity> {
    const partner = await this.partnerRepository.findOne({
      where: { publicId },
    });
    if (!partner) throw new NotFoundException('Partner not found');
    return partner;
  }
  async getForPartnerId(partnerId: string) {
    const partner = await this.findByIdOrThrow(partnerId);
    return toPartnerResponse(partner);
  }

  async setWebhookForPartnerId(
    partnerId: string,
    webhookUrl: string,
  ): Promise<{ webhookSecret: string }> {
    const partner = await this.findByIdOrThrow(partnerId);
    const secret = generateWebhookSecret();

    partner.webhookUrl = webhookUrl;
    partner.webhookSecretEncrypted = this.encryptionService.encrypt(secret);
    await this.partnerRepository.save(partner);

    // Shown once, same rule as everywhere else this pattern appears.
    return { webhookSecret: secret };
  }

  async setCheckoutReturnUrlForPartnerId(
    partnerId: string,
    checkoutReturnUrl: string,
  ) {
    const partner = await this.findByIdOrThrow(partnerId);
    partner.checkoutReturnUrl = checkoutReturnUrl;
    const saved = await this.partnerRepository.save(partner);
    return toPartnerResponse(saved);
  }

  private async findByIdOrThrow(id: string): Promise<PartnerEntity> {
    const partner = await this.partnerRepository.findOne({ where: { id } });
    if (!partner) throw new NotFoundException('Partner not found');
    return partner;
  }
}
