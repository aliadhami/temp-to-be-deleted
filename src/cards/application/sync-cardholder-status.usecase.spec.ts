import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CardEventSource } from '../domain/card-event-source.enum';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardholderStatus } from '../domain/cardholder-status.enum';
import { CardholderEnrolmentEntity } from '../infrastructure/persistence/cardholder-enrolment.entity';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';
import { CardholderEnrolmentResolver } from './cardholder-enrolment.resolver';
import { CardholderStatusSyncService } from './cardholder-status-sync.service';
import { SyncCardholderStatusUseCase } from './sync-cardholder-status.usecase';

describe('SyncCardholderStatusUseCase', () => {
  let useCase: SyncCardholderStatusUseCase;
  let cardholderRepository: { findOne: jest.Mock };
  let enrolmentResolver: { require: jest.Mock };
  let statusSyncService: { syncOne: jest.Mock };

  const enrolment = (
    overrides: Partial<CardholderEnrolmentEntity> = {},
  ): CardholderEnrolmentEntity =>
    ({
      id: '11',
      cardholderId: '1',
      providerKey: CardProviderKey.HYPERCARD,
      providerCardholderId: 'ref-1',
      status: CardholderStatus.APPROVED,
      ...overrides,
    }) as CardholderEnrolmentEntity;

  const sync = () => useCase.execute('ch-1', CardProviderKey.HYPERCARD);

  beforeEach(async () => {
    cardholderRepository = { findOne: jest.fn() };
    enrolmentResolver = { require: jest.fn() };
    statusSyncService = { syncOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncCardholderStatusUseCase,
        {
          provide: getRepositoryToken(CardholderEntity),
          useValue: cardholderRepository,
        },
        {
          provide: CardholderEnrolmentResolver,
          useValue: enrolmentResolver,
        },
        {
          provide: CardholderStatusSyncService,
          useValue: statusSyncService,
        },
      ],
    }).compile();

    useCase = module.get(SyncCardholderStatusUseCase);
    jest.clearAllMocks();
    cardholderRepository.findOne.mockResolvedValue({
      id: '1',
      publicId: 'ch-1',
      partnerId: 'partner-1',
    });
    enrolmentResolver.require.mockResolvedValue(enrolment());
  });

  it('publishes no live status for an issuer that was never asked', async () => {
    // The whole point of the flag. An issuer reporting no person-level status
    // is skipped, and publishing the stored value as `liveProviderStatus` would
    // present a value nobody asked for as one the issuer gave.
    statusSyncService.syncOne.mockResolvedValue({
      enrolment: enrolment(),
      queried: false,
    });

    await expect(sync()).resolves.toMatchObject({
      publicId: 'ch-1',
      providerKey: CardProviderKey.HYPERCARD,
      previousLocalStatus: CardholderStatus.APPROVED,
      liveProviderStatus: null,
      providerQueried: false,
      changed: false,
    });
  });

  it("publishes the provider's answer when one was obtained", async () => {
    statusSyncService.syncOne.mockResolvedValue({
      enrolment: enrolment({ status: CardholderStatus.COMPLIANCE_DECLINE }),
      queried: true,
    });

    await expect(sync()).resolves.toMatchObject({
      previousLocalStatus: CardholderStatus.APPROVED,
      liveProviderStatus: CardholderStatus.COMPLIANCE_DECLINE,
      providerQueried: true,
      changed: true,
    });
  });

  it('reads the status it compares against before the sync runs', async () => {
    // `syncOne` mutates the row it is handed, so a `previousLocalStatus` read
    // afterwards would equal the new value and `changed` would always be false.
    const subject = enrolment({ status: CardholderStatus.PENDING });
    enrolmentResolver.require.mockResolvedValue(subject);
    statusSyncService.syncOne.mockImplementation(
      (row: CardholderEnrolmentEntity) => (
        (row.status = CardholderStatus.APPROVED),
        Promise.resolve({ enrolment: row, queried: true })
      ),
    );

    await expect(sync()).resolves.toMatchObject({
      previousLocalStatus: CardholderStatus.PENDING,
      liveProviderStatus: CardholderStatus.APPROVED,
      changed: true,
    });
  });

  it('syncs under the reconcile source, not a partner-facing one', async () => {
    statusSyncService.syncOne.mockResolvedValue({
      enrolment: enrolment(),
      queried: true,
    });

    await sync();

    expect(statusSyncService.syncOne).toHaveBeenCalledWith(
      expect.anything(),
      CardEventSource.RECONCILE,
    );
  });

  it('reports an enrolment never staged at the provider rather than querying', async () => {
    // A null reference means onboarding never completed. The sync answers
    // `queried: false`, so the caller is told nothing was asked rather than
    // being handed the stored value.
    statusSyncService.syncOne.mockResolvedValue({
      enrolment: enrolment({ providerCardholderId: null }),
      queried: false,
    });

    await expect(sync()).resolves.toMatchObject({
      providerCardholderId: null,
      liveProviderStatus: null,
      providerQueried: false,
    });
  });

  it('refuses an issuer the cardholder was never enrolled with', async () => {
    enrolmentResolver.require.mockRejectedValueOnce(new ConflictException());

    await expect(sync()).rejects.toThrow(ConflictException);
    expect(statusSyncService.syncOne).not.toHaveBeenCalled();
  });

  it('refuses an unknown cardholder', async () => {
    cardholderRepository.findOne.mockResolvedValue(null);

    await expect(
      useCase.execute('nope', CardProviderKey.HYPERCARD),
    ).rejects.toThrow(NotFoundException);
    expect(statusSyncService.syncOne).not.toHaveBeenCalled();
  });
});
