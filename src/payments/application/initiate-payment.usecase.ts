import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PartnerEntity } from '../../partners/persistence/partner.entity';
import { isDuplicateEntryError } from '../../shared/persistence/duplicate-entry.util';
import { GatewayCapability } from '../domain/gateway-capability.enum';
import { GatewayKey } from '../domain/gateway-key.enum';
import { PaymentIntent } from '../domain/payment-intent.model';
import { PaymentMethod } from '../domain/payment-method.enum';
import { PaymentStatus } from '../domain/payment-status.enum';
import { AuditService } from '../infrastructure/audit/audit.service';
import { CredentialResolver } from '../infrastructure/credentials/credential-resolver';
import { resolveGatewayEnvironment } from '../infrastructure/credentials/gateway-environment.util';
import { GatewayRegistry } from '../infrastructure/gateway-registry';
import { PaymentTransactionEntity } from '../infrastructure/persistence/payment-transaction.entity';

export interface InitiatePaymentInput {
  partnerId: string;
  requestId: string;
  referenceNumber: string;
  gatewayKey: GatewayKey;
  method: PaymentMethod;
  amount: string;
  currency: string;
  customerEmail?: string;
  customerName?: string;
  customerCountry?: string;
  /** Crypto network (e.g. "TRON"); adapters that don't need it ignore it. */
  chainType?: string;
}

export interface InitiatePaymentOutput {
  publicId: string;
  status: PaymentStatus;
  redirectKind: 'REDIRECT' | 'FORM_POST';
  redirectUrl: string;
  params?: Record<string, string>;
}

@Injectable()
export class InitiatePaymentUseCase {
  constructor(
    @InjectRepository(PaymentTransactionEntity)
    private readonly transactionRepository: Repository<PaymentTransactionEntity>,
    @InjectRepository(PartnerEntity)
    private readonly partnerRepository: Repository<PartnerEntity>,
    private readonly gatewayRegistry: GatewayRegistry,
    private readonly credentialResolver: CredentialResolver,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
  ) {}

  async execute(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const partner = await this.partnerRepository.findOne({
      where: { id: input.partnerId },
    });
    if (!partner) {
      // Should be unreachable if the API key guard resolved a real partner —
      // never trust that silently, fail loudly if the FK is somehow stale.
      throw new NotFoundException('Partner not found');
    }

    this.assertPartnerIsAllowed(partner, input);

    const adapter = this.gatewayRegistry.resolve(input.gatewayKey);
    if (!adapter.capabilities.has(GatewayCapability.COLLECT)) {
      throw new ForbiddenException(
        `Gateway "${input.gatewayKey}" does not support collection`,
      );
    }

    const environment = resolveGatewayEnvironment(
      this.configService,
      input.gatewayKey,
    );
    const credentials = await this.credentialResolver.resolve({
      gatewayKey: input.gatewayKey,
      partnerId: input.partnerId,
      environment,
    });

    const callbackBaseUrl = this.configService.getOrThrow<string>(
      'PAYMENTS_CALLBACK_BASE_URL',
    );
    const callbackUrl = `${callbackBaseUrl}/payments/callback/${input.gatewayKey}`;

    // Persistence-first: the PENDING row exists before we ever call the provider.
    const transaction = this.transactionRepository.create({
      partnerId: input.partnerId,
      gatewayKey: input.gatewayKey,
      requestId: input.requestId,
      referenceNumber: input.referenceNumber,
      method: input.method,
      amount: input.amount,
      currency: input.currency,
      status: PaymentStatus.PENDING,
      customerEmail: input.customerEmail ?? null,
      customerName: input.customerName ?? null,
      customerCountry: input.customerCountry ?? null,
      callbackUrl,
      initiatedAt: new Date(),
    });

    let saved: PaymentTransactionEntity;
    try {
      saved = await this.transactionRepository.save(transaction);
    } catch (error) {
      if (this.isDuplicateRequestError(error)) {
        const existing = await this.transactionRepository.findOne({
          where: { gatewayKey: input.gatewayKey, requestId: input.requestId },
        });
        throw new ConflictException(
          `A payment with requestId "${input.requestId}" already exists for this gateway` +
            (existing
              ? ` (publicId: ${existing.publicId}, status: ${existing.status})`
              : ''),
        );
      }
      throw error;
    }

    const intent: PaymentIntent = {
      publicId: saved.publicId,
      partnerId: input.partnerId,
      partnerPublicId: partner.publicId,
      gatewayKey: input.gatewayKey,
      method: input.method,
      amount: input.amount,
      currency: input.currency,
      status: PaymentStatus.PENDING,
      refs: {
        requestId: input.requestId,
        referenceNumber: input.referenceNumber,
      },
      customer: {
        ...(input.customerEmail && { email: input.customerEmail }),
        ...(input.customerName && { name: input.customerName }),
        ...(input.customerCountry && { country: input.customerCountry }),
      },
      callbackUrl,
      ...(input.chainType && { chainType: input.chainType }),
    };

    const initiationResult = await adapter.initiate(intent, credentials);

    // Sanitized outbound payload for audit/debug — the adapter never puts
    // the raw secret key in these params, only signed request fields.
    saved.requestPayload = initiationResult.params ?? null;
    // Providers that hand back their own order id at creation time (rather than
    // only on callback) must have it persisted here, or nothing can query the
    // order's status later.
    if (initiationResult.providerRef) {
      saved.providerRef = initiationResult.providerRef;
    }
    await this.transactionRepository.save(saved);

    await this.auditService.record({
      actorUserId: null, // partner-initiated via API key, not a staff user
      action: 'PAYMENT_INITIATED',
      targetType: 'payment_transaction',
      targetPublicId: saved.publicId,
      afterJson: {
        gatewayKey: input.gatewayKey,
        amount: input.amount,
        currency: input.currency,
        partnerId: input.partnerId,
      },
    });

    return {
      publicId: saved.publicId,
      status: saved.status,
      redirectKind: initiationResult.kind,
      redirectUrl: initiationResult.url,
      ...(initiationResult.params && { params: initiationResult.params }),
    };
  }

  private assertPartnerIsAllowed(
    partner: PartnerEntity,
    input: InitiatePaymentInput,
  ): void {
    if (!partner.allowedGateways.includes(input.gatewayKey)) {
      throw new ForbiddenException(
        `Partner is not permitted to use gateway "${input.gatewayKey}"`,
      );
    }
    if (!partner.allowedCurrencies.includes(input.currency)) {
      throw new ForbiddenException(
        `Partner is not permitted to use currency "${input.currency}"`,
      );
    }
    if (!partner.allowedMethods.includes(input.method)) {
      throw new ForbiddenException(
        `Partner is not permitted to use method "${input.method}"`,
      );
    }
  }

  private isDuplicateRequestError(error: unknown): boolean {
    // Names no index: this table's only unique constraint reachable from here
    // is (gateway_key, request_id), which is exactly what a duplicate means.
    return isDuplicateEntryError(error);
  }
}
