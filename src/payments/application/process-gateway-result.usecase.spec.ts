import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { GatewayKey } from '../domain/gateway-key.enum';
import { PaymentStatus } from '../domain/payment-status.enum';
import { AuditService } from '../infrastructure/audit/audit.service';
import { CredentialResolver } from '../infrastructure/credentials/credential-resolver';
import { GatewayRegistry } from '../infrastructure/gateway-registry';
import { GatewayCallbackLogEntity } from '../infrastructure/persistence/gateway-callback-log.entity';
import { PaymentTransactionEntity } from '../infrastructure/persistence/payment-transaction.entity';
import { TransactionEventEntity } from '../infrastructure/persistence/transaction-event.entity';
import { WebhookDeliveryService } from '../infrastructure/webhooks/webhook-delivery.service';
import { ProcessGatewayResultUseCase } from './process-gateway-result.usecase';
import { PartnerEntity } from '../../partners/persistence/partner.entity';

const ctx = (payload: Record<string, unknown>) => ({
  payload,
  rawBody: JSON.stringify(payload),
  headers: {} as Record<string, string>,
});

describe('ProcessGatewayResultUseCase', () => {
  let useCase: ProcessGatewayResultUseCase;
  let transactionRepository: { findOne: jest.Mock };
  let callbackLogRepository: { create: jest.Mock; save: jest.Mock };
  let gatewayRegistry: { resolve: jest.Mock };
  let credentialResolver: { resolve: jest.Mock };
  let auditService: { record: jest.Mock };
  let webhookDeliveryService: { enqueueForTransaction: jest.Mock };
  let configService: { getOrThrow: jest.Mock };
  let mockManager: {
    getRepository: jest.Mock;
  };
  let queryBuilderMock: {
    setLock: jest.Mock;
    where: jest.Mock;
    getOne: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let partnerRepository: { findOne: jest.Mock };

  const baseTransaction: Partial<PaymentTransactionEntity> = {
    id: '1',
    publicId: 'txn-public-id',
    partnerId: 'partner-1',
    gatewayKey: GatewayKey.MLT,
    requestId: 'req-1',
    status: PaymentStatus.PENDING,
  };

  const adapter = {
    // Stands in for MLT's shape: reference at top-level RequestId. The use-case
    // must never read this field itself — it asks the adapter, so a provider
    // that nests it (SunPay) still resolves.
    extractRequestId: jest.fn(
      (context: { payload: Record<string, unknown> }) =>
        (context.payload.RequestId as string | undefined) ?? null,
    ),
    verifyResult: jest.fn(),
    callbackAck: jest.fn(() => ({ status: 200, body: 'OK' })),
    supportsBrowserRedirect: true,
  };

  beforeEach(async () => {
    transactionRepository = { findOne: jest.fn() };
    callbackLogRepository = {
      create: jest.fn((input: unknown) => input),
      save: jest.fn(),
    };
    gatewayRegistry = { resolve: jest.fn(() => adapter) };
    credentialResolver = { resolve: jest.fn().mockResolvedValue({}) };
    auditService = { record: jest.fn() };
    webhookDeliveryService = { enqueueForTransaction: jest.fn() };
    configService = { getOrThrow: jest.fn(() => 'uat') };
    partnerRepository = { findOne: jest.fn() };
    partnerRepository.findOne.mockResolvedValue({ checkoutReturnUrl: null });
    queryBuilderMock = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
    };

    const eventRepoMock = {
      create: jest.fn((input: unknown) => input),
      save: jest.fn(),
    };
    const txnRepoInTransaction = {
      createQueryBuilder: jest.fn(() => queryBuilderMock),
      save: jest.fn((input: unknown) => input),
    };

    mockManager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === PaymentTransactionEntity) return txnRepoInTransaction;
        if (entity === TransactionEventEntity) return eventRepoMock;
        throw new Error('Unexpected entity requested from manager');
      }),
    };

    dataSource = {
      transaction: jest.fn(async (cb: (manager: unknown) => Promise<void>) =>
        cb(mockManager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProcessGatewayResultUseCase,
        { provide: getDataSourceToken(), useValue: dataSource },
        {
          provide: getRepositoryToken(PaymentTransactionEntity),
          useValue: transactionRepository,
        },
        {
          provide: getRepositoryToken(GatewayCallbackLogEntity),
          useValue: callbackLogRepository,
        },
        { provide: GatewayRegistry, useValue: gatewayRegistry },
        { provide: CredentialResolver, useValue: credentialResolver },
        { provide: AuditService, useValue: auditService },
        { provide: ConfigService, useValue: configService },
        { provide: WebhookDeliveryService, useValue: webhookDeliveryService },
        {
          provide: getRepositoryToken(PartnerEntity),
          useValue: partnerRepository,
        },
      ],
    }).compile();

    useCase = module.get(ProcessGatewayResultUseCase);
    jest.clearAllMocks();
    gatewayRegistry.resolve.mockReturnValue(adapter);
    adapter.callbackAck.mockReturnValue({ status: 200, body: 'OK' });
  });

  it('always logs the raw callback, even when the transaction is unknown', async () => {
    transactionRepository.findOne.mockResolvedValueOnce(null);

    await useCase.execute(GatewayKey.MLT, ctx({ RequestId: 'unknown-req' }));

    expect(callbackLogRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionPublicId: null,
        signatureValid: false,
      }),
    );
  });

  it('never touches the ledger when the transaction is not found', async () => {
    transactionRepository.findOne.mockResolvedValueOnce(null);

    const ack = await useCase.execute(
      GatewayKey.MLT,
      ctx({
        RequestId: 'unknown-req',
      }),
    );

    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(ack).toEqual({ kind: 'ACK', status: 200, body: 'OK', contentType: 'text/plain' });
  });

  it('never touches the ledger when the signature is invalid', async () => {
    transactionRepository.findOne.mockResolvedValueOnce(baseTransaction);
    adapter.verifyResult.mockResolvedValueOnce({
      signatureValid: false,
      status: PaymentStatus.ERROR,
      refs: {},
    });

    await useCase.execute(GatewayKey.MLT, ctx({ RequestId: 'req-1' }));

    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
    expect(webhookDeliveryService.enqueueForTransaction).not.toHaveBeenCalled();
  });

  it('applies the status update, records an audit event, and enqueues a webhook on a valid callback', async () => {
    transactionRepository.findOne.mockResolvedValueOnce({ ...baseTransaction });
    adapter.verifyResult.mockResolvedValueOnce({
      signatureValid: true,
      status: PaymentStatus.PAID,
      refs: { providerRef: 'MLT-REF-1' },
      reasonCode: '100',
      message: 'Successful transaction',
    });
    queryBuilderMock.getOne.mockResolvedValueOnce({
      ...baseTransaction,
      status: PaymentStatus.PENDING,
    });

    await useCase.execute(GatewayKey.MLT, ctx({ RequestId: 'req-1' }));

    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PAYMENT_STATUS_UPDATED' }),
    );
    expect(webhookDeliveryService.enqueueForTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1' }),
      PaymentStatus.PAID,
    );
  });

  it('ignores a duplicate callback on an already-terminal transaction — no audit, no webhook', async () => {
    transactionRepository.findOne.mockResolvedValueOnce({
      ...baseTransaction,
      status: PaymentStatus.PAID,
    });
    adapter.verifyResult.mockResolvedValueOnce({
      signatureValid: true,
      status: PaymentStatus.PAID,
      refs: {},
    });
    // Row is already terminal when locked/re-read inside the transaction
    queryBuilderMock.getOne.mockResolvedValueOnce({
      ...baseTransaction,
      status: PaymentStatus.PAID,
    });

    await useCase.execute(GatewayKey.MLT, ctx({ RequestId: 'req-1' }));

    expect(auditService.record).not.toHaveBeenCalled();
    expect(webhookDeliveryService.enqueueForTransaction).not.toHaveBeenCalled();
  });

  it('does not enqueue a webhook for a non-terminal mapped status', async () => {
    transactionRepository.findOne.mockResolvedValueOnce({ ...baseTransaction });
    adapter.verifyResult.mockResolvedValueOnce({
      signatureValid: true,
      status: PaymentStatus.PENDING,
      refs: {},
    });
    queryBuilderMock.getOne.mockResolvedValueOnce({
      ...baseTransaction,
      status: PaymentStatus.PENDING,
    });

    await useCase.execute(GatewayKey.MLT, ctx({ RequestId: 'req-1' }));

    expect(webhookDeliveryService.enqueueForTransaction).not.toHaveBeenCalled();
  });
  it('redirects to the partner checkout return URL with publicId appended, for a browser-redirect gateway', async () => {
    transactionRepository.findOne.mockResolvedValueOnce({ ...baseTransaction });
    adapter.verifyResult.mockResolvedValueOnce({
      signatureValid: true,
      status: PaymentStatus.PAID,
      refs: {},
    });
    queryBuilderMock.getOne.mockResolvedValueOnce({
      ...baseTransaction,
      status: PaymentStatus.PENDING,
    });
    partnerRepository.findOne.mockResolvedValueOnce({
      checkoutReturnUrl: 'https://partner.example.com/checkout/return',
    });
    (adapter as { supportsBrowserRedirect?: boolean }).supportsBrowserRedirect =
      true;

    const result = await useCase.execute(
      GatewayKey.MLT,
      ctx({
        RequestId: 'req-1',
      }),
    );

    expect(result).toEqual({
      kind: 'REDIRECT',
      url: 'https://partner.example.com/checkout/return?publicId=txn-public-id',
    });
  });

  it('falls back to the plain ack when the partner has no checkout return URL configured', async () => {
    transactionRepository.findOne.mockResolvedValueOnce({ ...baseTransaction });
    adapter.verifyResult.mockResolvedValueOnce({
      signatureValid: true,
      status: PaymentStatus.PAID,
      refs: {},
    });
    queryBuilderMock.getOne.mockResolvedValueOnce({
      ...baseTransaction,
      status: PaymentStatus.PENDING,
    });
    partnerRepository.findOne.mockResolvedValueOnce({
      checkoutReturnUrl: null,
    });
    (adapter as { supportsBrowserRedirect?: boolean }).supportsBrowserRedirect =
      true;

    const result = await useCase.execute(
      GatewayKey.MLT,
      ctx({
        RequestId: 'req-1',
      }),
    );

    expect(result).toEqual({ kind: 'ACK', status: 200, body: 'OK', contentType: 'text/plain' });
  });

  it('never redirects for a gateway that does not support browser redirect', async () => {
    transactionRepository.findOne.mockResolvedValueOnce({ ...baseTransaction });
    adapter.verifyResult.mockResolvedValueOnce({
      signatureValid: true,
      status: PaymentStatus.PAID,
      refs: {},
    });
    queryBuilderMock.getOne.mockResolvedValueOnce({
      ...baseTransaction,
      status: PaymentStatus.PENDING,
    });
    partnerRepository.findOne.mockResolvedValueOnce({
      checkoutReturnUrl: 'https://partner.example.com/checkout/return',
    });
    (adapter as { supportsBrowserRedirect?: boolean }).supportsBrowserRedirect =
      false;

    const result = await useCase.execute(
      GatewayKey.MLT,
      ctx({
        RequestId: 'req-1',
      }),
    );

    expect(result).toEqual({ kind: 'ACK', status: 200, body: 'OK', contentType: 'text/plain' });
  });
});
