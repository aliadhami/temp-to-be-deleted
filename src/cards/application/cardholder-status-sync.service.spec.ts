import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WebhookDeliveryService } from '../../payments/infrastructure/webhooks/webhook-delivery.service';
import { CardCapability } from '../domain/card-capability.enum';
import { CardEventSource } from '../domain/card-event-source.enum';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardholderStatus } from '../domain/cardholder-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardholderEnrolmentEntity } from '../infrastructure/persistence/cardholder-enrolment.entity';
import { CardholderEventEntity } from '../infrastructure/persistence/cardholder-event.entity';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';
import { CardholderStatusSyncService } from './cardholder-status-sync.service';

describe('CardholderStatusSyncService', () => {
  let service: CardholderStatusSyncService;
  let enrolmentRepository: { save: jest.Mock };
  let cardholderRepository: { findOne: jest.Mock };
  let eventRepository: { create: jest.Mock; save: jest.Mock };
  let cardIssuerRegistry: { resolve: jest.Mock };
  let webhookDeliveryService: { enqueueForCardholder: jest.Mock };

  const adapter = {
    capabilities: new Set([
      CardCapability.ONBOARD_CARDHOLDER,
      CardCapability.CARDHOLDER_STATUS,
    ]),
    queryCardholderStatus: jest.fn(),
  };

  const enrolment = (): CardholderEnrolmentEntity =>
    ({
      id: '11',
      cardholderId: '1',
      providerKey: CardProviderKey.AXYS,
      providerCardholderId: 'axys-1',
      status: CardholderStatus.UNDER_REVIEW,
    }) as CardholderEnrolmentEntity;

  beforeEach(async () => {
    enrolmentRepository = { save: jest.fn((x: unknown) => x) };
    cardholderRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: '1',
        publicId: 'ch-1',
        partnerId: 'partner-1',
      }),
    };
    eventRepository = { create: jest.fn((x: unknown) => x), save: jest.fn() };
    cardIssuerRegistry = { resolve: jest.fn(() => adapter) };
    webhookDeliveryService = { enqueueForCardholder: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CardholderStatusSyncService,
        {
          provide: getRepositoryToken(CardholderEnrolmentEntity),
          useValue: enrolmentRepository,
        },
        {
          provide: getRepositoryToken(CardholderEntity),
          useValue: cardholderRepository,
        },
        {
          provide: getRepositoryToken(CardholderEventEntity),
          useValue: eventRepository,
        },
        { provide: CardIssuerRegistry, useValue: cardIssuerRegistry },
        {
          provide: WebhookDeliveryService,
          useValue: webhookDeliveryService,
        },
      ],
    }).compile();

    service = module.get(CardholderStatusSyncService);
    jest.clearAllMocks();
    cardIssuerRegistry.resolve.mockReturnValue(adapter);
  });

  it('skips a provider that cannot report cardholder status, without throwing', async () => {
    // Skipped rather than thrown: this runs from the reconcile sweep over
    // every pending enrolment, so one provider that cannot answer must not
    // abort the pass for the rest.
    const stub = { capabilities: new Set(), queryCardholderStatus: jest.fn() };
    cardIssuerRegistry.resolve.mockReturnValueOnce(stub);
    const subject = enrolment();

    await expect(
      service.syncOne(subject, CardEventSource.SYSTEM),
    ).resolves.toEqual({ enrolment: subject, queried: false });

    expect(stub.queryCardholderStatus).not.toHaveBeenCalled();
    expect(enrolmentRepository.save).not.toHaveBeenCalled();
  });

  it('skips an issuer that onboards a cardholder but holds no person to report on', async () => {
    // Skipping leaves the stored status alone, which is what stops an answer
    // composed for an issuer holding no person overwriting it.
    const stub = {
      capabilities: new Set([CardCapability.ONBOARD_CARDHOLDER]),
      queryCardholderStatus: jest.fn(),
    };
    cardIssuerRegistry.resolve.mockReturnValueOnce(stub);
    const subject = enrolment();

    const result = await service.syncOne(subject, CardEventSource.SYSTEM);

    // `queried: false` is the load-bearing half: a caller publishing the status
    // must be able to tell a stored value from one the issuer gave.
    expect(result).toEqual({ enrolment: subject, queried: false });
    expect(stub.queryCardholderStatus).not.toHaveBeenCalled();
    expect(subject.status).toBe(CardholderStatus.UNDER_REVIEW);
    expect(enrolmentRepository.save).not.toHaveBeenCalled();
  });

  it('reports an enrolment with no provider reference as unqueried', async () => {
    const subject = {
      ...enrolment(),
      providerCardholderId: null,
    } as CardholderEnrolmentEntity;

    await expect(
      service.syncOne(subject, CardEventSource.SYSTEM),
    ).resolves.toEqual({ enrolment: subject, queried: false });
    expect(adapter.queryCardholderStatus).not.toHaveBeenCalled();
  });

  it('persists a changed status when the capability is declared', async () => {
    adapter.queryCardholderStatus.mockResolvedValueOnce({
      status: CardholderStatus.APPROVED,
    });

    const result = await service.syncOne(enrolment(), CardEventSource.SYSTEM);

    expect(result.queried).toBe(true);
    expect(enrolmentRepository.save).toHaveBeenCalled();
    expect(eventRepository.save).toHaveBeenCalled();
  });

  it('names the issuer on the webhook, so a partner can tell which one decided', async () => {
    // One person can be approved at one issuer and pending at another, so the
    // event is unreadable without the key that says whose decision it was.
    adapter.queryCardholderStatus.mockResolvedValueOnce({
      status: CardholderStatus.APPROVED,
    });

    await service.syncOne(enrolment(), CardEventSource.SYSTEM);

    expect(webhookDeliveryService.enqueueForCardholder).toHaveBeenCalledWith(
      '1',
      'partner-1',
      'cardholder.status_updated',
      expect.objectContaining({
        cardholderPublicId: 'ch-1',
        providerKey: CardProviderKey.AXYS,
        status: CardholderStatus.APPROVED,
      }),
    );
  });

  it('reports an unchanged status as queried, having actually asked', async () => {
    adapter.queryCardholderStatus.mockResolvedValueOnce({
      status: CardholderStatus.UNDER_REVIEW,
    });

    const subject = enrolment();
    await expect(
      service.syncOne(subject, CardEventSource.SYSTEM),
    ).resolves.toEqual({ enrolment: subject, queried: true });
    expect(enrolmentRepository.save).not.toHaveBeenCalled();
  });
});
