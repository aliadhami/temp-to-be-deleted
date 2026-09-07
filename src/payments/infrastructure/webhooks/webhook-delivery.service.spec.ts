import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PartnerEntity } from '../../../partners/persistence/partner.entity';
import { CredentialEncryptionService } from '../../../shared/crypto/credential-encryption.service';
import { PaymentStatus } from '../../domain/payment-status.enum';
import { PaymentTransactionEntity } from '../persistence/payment-transaction.entity';
import {
  WebhookDeliveryEntity,
  WebhookDeliveryStatus,
} from './webhook-delivery.entity';
import { WebhookDeliveryService } from './webhook-delivery.service';

describe('WebhookDeliveryService', () => {
  let service: WebhookDeliveryService;
  let deliveryRepository: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
  };
  let partnerRepository: { findOne: jest.Mock };
  let encryptionService: { encrypt: jest.Mock; decrypt: jest.Mock };
  let fetchMock: jest.Mock;

  const transaction: Partial<PaymentTransactionEntity> = {
    id: '1',
    publicId: 'txn-public-id',
    partnerId: 'partner-1',
    gatewayKey: 'MLT' as never,
    referenceNumber: 'ref-1',
    amount: '10.00',
    currency: 'AED',
  };

  beforeEach(async () => {
    deliveryRepository = {
      create: jest.fn((input: unknown) => input),
      save: jest.fn((input: unknown) => input),
      find: jest.fn(),
    };
    partnerRepository = { findOne: jest.fn() };
    encryptionService = { encrypt: jest.fn(), decrypt: jest.fn() };
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDeliveryService,
        {
          provide: getRepositoryToken(WebhookDeliveryEntity),
          useValue: deliveryRepository,
        },
        {
          provide: getRepositoryToken(PartnerEntity),
          useValue: partnerRepository,
        },
        { provide: CredentialEncryptionService, useValue: encryptionService },
      ],
    }).compile();

    service = module.get(WebhookDeliveryService);
  });

  describe('enqueueForTransaction', () => {
    it('does nothing when the partner has no webhookUrl configured', async () => {
      partnerRepository.findOne.mockResolvedValueOnce({
        id: 'partner-1',
        webhookUrl: null,
      });

      await service.enqueueForTransaction(
        transaction as PaymentTransactionEntity,
        PaymentStatus.PAID,
      );

      expect(deliveryRepository.create).not.toHaveBeenCalled();
      expect(deliveryRepository.save).not.toHaveBeenCalled();
    });

    it('does nothing when the transaction has no partnerId', async () => {
      await service.enqueueForTransaction(
        {
          ...transaction,
          partnerId: null,
        } as unknown as PaymentTransactionEntity,
        PaymentStatus.PAID,
      );
      expect(partnerRepository.findOne).not.toHaveBeenCalled();
    });

    it('creates a PENDING delivery row with the correct payload shape when webhook is configured', async () => {
      partnerRepository.findOne.mockResolvedValueOnce({
        id: 'partner-1',
        webhookUrl: 'https://partner.example.com/hook',
      });

      await service.enqueueForTransaction(
        transaction as PaymentTransactionEntity,
        PaymentStatus.PAID,
      );

      expect(deliveryRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          partnerId: 'partner-1',
          transactionId: '1',
          status: WebhookDeliveryStatus.PENDING,
          attemptCount: 0,
          payload: expect.objectContaining({
            paymentPublicId: 'txn-public-id',
            status: PaymentStatus.PAID,
          }),
        }),
      );
    });
  });

  describe('processDueDeliveries -> attemptDelivery', () => {
    const dueDelivery: Partial<WebhookDeliveryEntity> = {
      id: '1',
      publicId: 'delivery-1',
      partnerId: 'partner-1',
      payload: { foo: 'bar' },
      attemptCount: 0,
      status: WebhookDeliveryStatus.PENDING,
    };

    it('dead-letters immediately if the partner webhook config disappeared', async () => {
      deliveryRepository.find.mockResolvedValueOnce([{ ...dueDelivery }]); // <-- spread here too
      partnerRepository.findOne.mockResolvedValueOnce({
        webhookUrl: null,
        webhookSecretEncrypted: null,
      });

      await service.processDueDeliveries();

      const saved = deliveryRepository.save.mock.calls.at(-1)?.[0];
      expect(saved.status).toBe(WebhookDeliveryStatus.DEAD_LETTER);
    });

    it('marks DELIVERED on a 2xx response and includes a valid HMAC signature header', async () => {
      deliveryRepository.find.mockResolvedValueOnce([{ ...dueDelivery }]);
      partnerRepository.findOne.mockResolvedValueOnce({
        webhookUrl: 'https://partner.example.com/hook',
        webhookSecretEncrypted: Buffer.from('encrypted'),
      });
      encryptionService.decrypt.mockReturnValueOnce('plain-secret');
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

      await service.processDueDeliveries();

      expect(fetchMock).toHaveBeenCalledWith(
        'https://partner.example.com/hook',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'X-Webhook-Signature': expect.any(String),
            'X-Webhook-Timestamp': expect.any(String),
          }),
        }),
      );
      const saved = deliveryRepository.save.mock.calls.at(-1)?.[0];
      expect(saved.status).toBe(WebhookDeliveryStatus.DELIVERED);
      expect(saved.deliveredAt).toBeInstanceOf(Date);
    });

    it('schedules a retry with the correct backoff on a non-2xx response', async () => {
      deliveryRepository.find.mockResolvedValueOnce([
        { ...dueDelivery, attemptCount: 0 },
      ]);
      partnerRepository.findOne.mockResolvedValueOnce({
        webhookUrl: 'https://partner.example.com/hook',
        webhookSecretEncrypted: Buffer.from('encrypted'),
      });
      encryptionService.decrypt.mockReturnValueOnce('plain-secret');
      fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });

      const before = Date.now();
      await service.processDueDeliveries();

      const saved = deliveryRepository.save.mock.calls.at(-1)?.[0];
      expect(saved.status).toBe(WebhookDeliveryStatus.PENDING);
      expect(saved.attemptCount).toBe(1);
      // first retry backoff is 1 minute
      expect(saved.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
        before + 59_000,
      );
      expect(saved.nextAttemptAt.getTime()).toBeLessThanOrEqual(
        before + 61_000,
      );
    });

    it('dead-letters after reaching the max attempt count', async () => {
      deliveryRepository.find.mockResolvedValueOnce([
        { ...dueDelivery, attemptCount: 4 },
      ]);
      partnerRepository.findOne.mockResolvedValueOnce({
        webhookUrl: 'https://partner.example.com/hook',
        webhookSecretEncrypted: Buffer.from('encrypted'),
      });
      encryptionService.decrypt.mockReturnValueOnce('plain-secret');
      fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });

      await service.processDueDeliveries();

      const saved = deliveryRepository.save.mock.calls.at(-1)?.[0];
      expect(saved.status).toBe(WebhookDeliveryStatus.DEAD_LETTER);
      expect(saved.attemptCount).toBe(5);
      expect(saved.nextAttemptAt).toBeNull();
    });

    it('schedules a retry on a network/fetch error, not just HTTP error responses', async () => {
      deliveryRepository.find.mockResolvedValueOnce([
        { ...dueDelivery, attemptCount: 0 },
      ]);
      partnerRepository.findOne.mockResolvedValueOnce({
        webhookUrl: 'https://partner.example.com/hook',
        webhookSecretEncrypted: Buffer.from('encrypted'),
      });
      encryptionService.decrypt.mockReturnValueOnce('plain-secret');
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await service.processDueDeliveries();

      const saved = deliveryRepository.save.mock.calls.at(-1)?.[0];
      expect(saved.status).toBe(WebhookDeliveryStatus.PENDING);
      expect(saved.lastError).toContain('ECONNREFUSED');
    });
  });
});
