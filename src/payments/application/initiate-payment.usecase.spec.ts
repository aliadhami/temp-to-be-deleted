import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { PartnerEntity } from '../../partners/persistence/partner.entity';
import { GatewayCapability } from '../domain/gateway-capability.enum';
import { GatewayKey } from '../domain/gateway-key.enum';
import { PaymentMethod } from '../domain/payment-method.enum';
import { PaymentStatus } from '../domain/payment-status.enum';
import { AuditService } from '../infrastructure/audit/audit.service';
import { CredentialResolver } from '../infrastructure/credentials/credential-resolver';
import { GatewayRegistry } from '../infrastructure/gateway-registry';
import { PaymentTransactionEntity } from '../infrastructure/persistence/payment-transaction.entity';
import { InitiatePaymentUseCase } from './initiate-payment.usecase';

describe('InitiatePaymentUseCase', () => {
  let useCase: InitiatePaymentUseCase;
  let transactionRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
  };
  let partnerRepository: { findOne: jest.Mock };
  let gatewayRegistry: { resolve: jest.Mock };
  let credentialResolver: { resolve: jest.Mock };
  let auditService: { record: jest.Mock };
  let configService: { getOrThrow: jest.Mock };

  const partner: Partial<PartnerEntity> = {
    id: 'partner-1',
    allowedGateways: ['MLT'],
    allowedCurrencies: ['AED'],
    allowedMethods: ['FIAT_CARD'],
  };

  const adapter = {
    capabilities: new Set([GatewayCapability.COLLECT]),
    initiate: jest.fn(),
  };

  const baseInput = {
    partnerId: 'partner-1',
    requestId: 'req-1',
    referenceNumber: 'ref-1',
    gatewayKey: GatewayKey.MLT,
    method: PaymentMethod.FIAT_CARD,
    amount: '10.00',
    currency: 'AED',
  };

  beforeEach(async () => {
    transactionRepository = {
      create: jest.fn((input: Record<string, unknown>) => ({
        ...input,
        id: '1',
        publicId: 'txn-public-id',
      })),
      save: jest.fn(),
      findOne: jest.fn(),
    };
    partnerRepository = { findOne: jest.fn() };
    gatewayRegistry = { resolve: jest.fn(() => adapter) };
    credentialResolver = { resolve: jest.fn().mockResolvedValue({}) };
    auditService = { record: jest.fn() };
    configService = {
      getOrThrow: jest.fn((key: string) =>
        key === 'PAYMENTS_CALLBACK_BASE_URL'
          ? 'https://api.example.com'
          : 'uat',
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InitiatePaymentUseCase,
        {
          provide: getRepositoryToken(PaymentTransactionEntity),
          useValue: transactionRepository,
        },
        {
          provide: getRepositoryToken(PartnerEntity),
          useValue: partnerRepository,
        },
        { provide: GatewayRegistry, useValue: gatewayRegistry },
        { provide: CredentialResolver, useValue: credentialResolver },
        { provide: AuditService, useValue: auditService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    useCase = module.get(InitiatePaymentUseCase);
    jest.clearAllMocks();
    partnerRepository.findOne.mockResolvedValue(partner);
    gatewayRegistry.resolve.mockReturnValue(adapter);
    adapter.initiate.mockResolvedValue({
      kind: 'FORM_POST',
      url: 'https://gateway.example.com/pay',
      params: { RequestId: 'req-1' },
    });
    transactionRepository.save.mockImplementation((input: unknown) => input);
  });

  it('throws NotFoundException if the partner behind the resolved partnerId is missing', async () => {
    partnerRepository.findOne.mockResolvedValueOnce(null);
    await expect(useCase.execute(baseInput)).rejects.toThrow(NotFoundException);
  });

  it('throws ForbiddenException when the gateway is not in the partner allow-list', async () => {
    partnerRepository.findOne.mockResolvedValueOnce({
      ...partner,
      allowedGateways: ['SUNPAY'],
    });
    await expect(useCase.execute(baseInput)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('throws ForbiddenException when the currency is not in the partner allow-list', async () => {
    partnerRepository.findOne.mockResolvedValueOnce({
      ...partner,
      allowedCurrencies: ['USD'],
    });
    await expect(useCase.execute(baseInput)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('throws ForbiddenException when the method is not in the partner allow-list', async () => {
    partnerRepository.findOne.mockResolvedValueOnce({
      ...partner,
      allowedMethods: ['CRYPTO'],
    });
    await expect(useCase.execute(baseInput)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('throws ForbiddenException when the gateway does not support COLLECT', async () => {
    gatewayRegistry.resolve.mockReturnValueOnce({
      capabilities: new Set(),
      initiate: jest.fn(),
    });
    await expect(useCase.execute(baseInput)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('writes the transaction as PENDING before calling the adapter (persistence-first)', async () => {
    const callOrder: string[] = [];
    transactionRepository.save.mockImplementationOnce((input: unknown) => {
      callOrder.push('db-save');
      return input;
    });
    adapter.initiate.mockImplementationOnce(async (...args: unknown[]) => {
      callOrder.push('adapter-initiate');
      return {
        kind: 'FORM_POST',
        url: 'https://gateway.example.com/pay',
        params: {},
      };
    });

    await useCase.execute(baseInput);

    expect(callOrder).toEqual(['db-save', 'adapter-initiate']);
  });

  it('builds the callback URL from config, scoped to the gateway key', async () => {
    await useCase.execute(baseInput);

    const createdArg = transactionRepository.create.mock.calls[0][0];
    expect(createdArg.callbackUrl).toBe(
      'https://api.example.com/payments/callback/MLT',
    );
  });

  it('returns a ConflictException with the existing transaction info on a duplicate requestId', async () => {
    const duplicateError = Object.create(QueryFailedError.prototype);
    duplicateError.code = 'ER_DUP_ENTRY';
    transactionRepository.save.mockRejectedValueOnce(duplicateError);
    transactionRepository.findOne.mockResolvedValueOnce({
      publicId: 'existing-txn-id',
      status: PaymentStatus.PENDING,
    });

    await expect(useCase.execute(baseInput)).rejects.toThrow(ConflictException);
  });

  it('re-throws non-duplicate database errors unchanged', async () => {
    transactionRepository.save.mockRejectedValueOnce(
      new Error('connection lost'),
    );
    await expect(useCase.execute(baseInput)).rejects.toThrow('connection lost');
  });

  it('records an audit event on successful initiation', async () => {
    await useCase.execute(baseInput);
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PAYMENT_INITIATED',
        targetPublicId: 'txn-public-id',
      }),
    );
  });

  it('omits optional customer fields from the intent when not provided', async () => {
    await useCase.execute(baseInput); // no customerEmail/customerName/customerCountry

    const intentArg = adapter.initiate.mock.calls[0][0];
    expect(intentArg.customer).toEqual({});
  });

  it('includes provided customer fields in the intent', async () => {
    await useCase.execute({
      ...baseInput,
      customerEmail: 'test@example.com',
      customerName: 'Test User',
      customerCountry: 'AE',
    });

    const intentArg = adapter.initiate.mock.calls[0][0];
    expect(intentArg.customer).toEqual({
      email: 'test@example.com',
      name: 'Test User',
      country: 'AE',
    });
  });
});
