import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardType } from '../domain/card-type.enum';
import { CardApplicationStatus } from '../domain/card-application-status.enum';
import { CardLifecycleOperation } from '../domain/card-lifecycle-operation.enum';
import { CardApplicationEntity } from '../infrastructure/persistence/card-application.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';
import { CardOperationAvailability } from './card-operation-availability';
import { CardOperationEntity } from '../infrastructure/persistence/card-operation.entity';
import { CardOperationStatus } from '../domain/card-operation-status.enum';
import { GetCardUseCase } from './get-card.usecase';

describe('GetCardUseCase', () => {
  let useCase: GetCardUseCase;
  let cardRepository: { findOne: jest.Mock; findAndCount: jest.Mock };
  let cardholderRepository: { findOne: jest.Mock; find: jest.Mock };
  let applicationRepository: { findOne: jest.Mock; find: jest.Mock };
  let cardOperationAvailability: { forCards: jest.Mock };
  let operationRepository: {
    createQueryBuilder: jest.Mock;
    metadata: { tableName: string };
  };
  /** What the group-wise-maximum query answers with. */
  let lastOperations: Partial<CardOperationEntity>[];

  const application = (
    overrides: Partial<CardApplicationEntity> = {},
  ): CardApplicationEntity =>
    ({
      id: '100',
      cardId: '1',
      cardProductId: null,
      status: CardApplicationStatus.APPROVED,
      reasonCode: null,
      message: null,
      statusCheckedAt: new Date('2026-01-01T00:05:00.000Z'),
      ...overrides,
    }) as CardApplicationEntity;

  const cardholder = (
    overrides: Partial<CardholderEntity> = {},
  ): CardholderEntity =>
    ({
      id: '20',
      publicId: 'c0000000-0000-4000-8000-000000000001',
      ...overrides,
    }) as CardholderEntity;

  const row = (overrides: Partial<CardEntity> = {}): CardEntity =>
    ({
      id: '1',
      publicId: 'a1b2c3d4-0000-4000-8000-000000000001',
      partnerId: '10',
      cardholderId: '20',
      providerKey: CardProviderKey.HYPERCARD,
      providerCardId: 'hc-card-1',
      cardType: CardType.VIRTUAL,
      nameOnCard: 'Ada Lovelace',
      currency: 'USD',
      status: CardStatus.ACTIVE,
      maskedPan: '**** **** **** 1234',
      balanceAvailable: null,
      balanceLedger: null,
      balanceCurrency: null,
      balanceObservedAt: null,
      statusCheckedAt: null,
      responsePayload: { their: 'payload' },
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      ...overrides,
    }) as CardEntity;

  beforeEach(async () => {
    cardRepository = { findOne: jest.fn(), findAndCount: jest.fn() };
    cardholderRepository = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([cardholder()]),
    };
    applicationRepository = {
      findOne: jest.fn().mockResolvedValue(application()),
      find: jest.fn().mockResolvedValue([application()]),
    };
    cardOperationAvailability = {
      forCards: jest
        .fn()
        .mockImplementation((entries: readonly unknown[]) =>
          Promise.resolve(entries.map(() => [CardLifecycleOperation.BLOCK])),
        ),
    };
    lastOperations = [];
    operationRepository = {
      // The real table name, because the query builds its subquery from it.
      metadata: { tableName: 'card_operation' },
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn(() => Promise.resolve(lastOperations)),
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetCardUseCase,
        { provide: getRepositoryToken(CardEntity), useValue: cardRepository },
        {
          provide: getRepositoryToken(CardholderEntity),
          useValue: cardholderRepository,
        },
        {
          provide: getRepositoryToken(CardApplicationEntity),
          useValue: applicationRepository,
        },
        {
          provide: getRepositoryToken(CardOperationEntity),
          useValue: operationRepository,
        },
        {
          provide: CardOperationAvailability,
          useValue: cardOperationAvailability,
        },
      ],
    }).compile();

    useCase = module.get(GetCardUseCase);
  });

  describe('the card a partner reads back', () => {
    it('names the issuer holding it', async () => {
      cardRepository.findOne.mockResolvedValue(row());

      await expect(
        useCase.execute('10', 'a1b2c3d4-0000-4000-8000-000000000001'),
      ).resolves.toMatchObject({ providerKey: CardProviderKey.HYPERCARD });
    });

    it('carries none of the issuer’s own vocabulary, and no internal id', async () => {
      cardRepository.findOne.mockResolvedValue(row());

      const card = await useCase.execute(
        '10',
        'a1b2c3d4-0000-4000-8000-000000000001',
      );

      // Our key for an issuer is a partner-facing fact; the issuer's own
      // identifier for the card and its raw response are not.
      expect(card).not.toHaveProperty('id');
      expect(card).not.toHaveProperty('providerCardId');
      expect(card).not.toHaveProperty('responsePayload');
      expect(card).not.toHaveProperty('partnerId');
      expect(card).not.toHaveProperty('cardholderId');
    });

    it('names the person it was issued to, by our id', async () => {
      cardRepository.findOne.mockResolvedValue(row({ cardholderId: '20' }));

      const card = await useCase.execute(
        '10',
        'a1b2c3d4-0000-4000-8000-000000000001',
      );

      expect(card.cardholderPublicId).toBe(
        'c0000000-0000-4000-8000-000000000001',
      );
      expect(cardholderRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ select: { id: true, publicId: true } }),
      );
    });

    it('fails loudly for a card whose cardholder row is missing', async () => {
      cardRepository.findOne.mockResolvedValue(row());
      cardholderRepository.find.mockResolvedValue([]);

      await expect(
        useCase.execute('10', 'a1b2c3d4-0000-4000-8000-000000000001'),
      ).rejects.toThrow('names a cardholder that does not exist');
    });

    it('reports no balance until one has been read', async () => {
      cardRepository.findOne.mockResolvedValue(row());

      await expect(
        useCase.execute('10', 'a1b2c3d4-0000-4000-8000-000000000001'),
      ).resolves.toMatchObject({ balance: null });
    });

    it('reports the balance as a nested object once one has', async () => {
      const observedAt = new Date('2026-02-01T00:00:00.000Z');
      cardRepository.findOne.mockResolvedValue(
        row({
          balanceAvailable: '125.40',
          balanceLedger: '130.00',
          balanceCurrency: 'USD',
          balanceObservedAt: observedAt,
        }),
      );

      await expect(
        useCase.execute('10', 'a1b2c3d4-0000-4000-8000-000000000001'),
      ).resolves.toMatchObject({
        balance: {
          available: '125.40',
          ledger: '130.00',
          currency: 'USD',
          observedAt,
        },
      });
    });

    it('reports how the attempt to open it is going', async () => {
      // The only thing separating a healthy wait from a failed opening, which
      // otherwise read identically.
      cardRepository.findOne.mockResolvedValue(
        row({ status: CardStatus.NOT_ACTIVATED, maskedPan: null }),
      );
      applicationRepository.findOne.mockResolvedValue(
        application({
          status: CardApplicationStatus.SUBMITTED,
          statusCheckedAt: new Date('2026-01-01T00:05:00.000Z'),
        }),
      );

      const card = await useCase.execute(
        '10',
        'a1b2c3d4-0000-4000-8000-000000000001',
      );

      expect(card.issuance).toEqual({
        status: CardApplicationStatus.SUBMITTED,
        reasonCode: null,
        reason: null,
        lastCheckedAt: new Date('2026-01-01T00:05:00.000Z'),
      });
    });

    it('names why an attempt failed, in the issuer’s own words', async () => {
      cardRepository.findOne.mockResolvedValue(row());
      applicationRepository.findOne.mockResolvedValue(
        application({
          status: CardApplicationStatus.SUBMISSION_FAILED,
          reasonCode: 'SUBMISSION_ERROR',
          message: 'the issuer refused the application',
        }),
      );

      const card = await useCase.execute(
        '10',
        'a1b2c3d4-0000-4000-8000-000000000001',
      );

      expect(card.issuance).toMatchObject({
        status: CardApplicationStatus.SUBMISSION_FAILED,
        reasonCode: 'SUBMISSION_ERROR',
        reason: 'the issuer refused the application',
      });
    });

    it('reports no issuance for a card opened outside the issuance path', async () => {
      cardRepository.findOne.mockResolvedValue(row());
      applicationRepository.findOne.mockResolvedValue(null);

      const card = await useCase.execute(
        '10',
        'a1b2c3d4-0000-4000-8000-000000000001',
      );

      expect(card.issuance).toBeNull();
    });

    it('says what the card accepts now', async () => {
      cardRepository.findOne.mockResolvedValue(row());
      applicationRepository.findOne.mockResolvedValue(
        application({ cardProductId: '500' }),
      );

      const card = await useCase.execute(
        '10',
        'a1b2c3d4-0000-4000-8000-000000000001',
      );

      // The narrowing itself belongs to the helper the write path validates
      // through, so this read only has to hand it the card's two inputs.
      expect(cardOperationAvailability.forCards).toHaveBeenCalledWith([
        { providerKey: CardProviderKey.HYPERCARD, cardProductId: '500' },
      ]);
      expect(card.availableOperations).toEqual([CardLifecycleOperation.BLOCK]);
    });

    it('names no product for a card whose issuer has no catalogue', async () => {
      cardRepository.findOne.mockResolvedValue(row());
      applicationRepository.findOne.mockResolvedValue(null);

      await useCase.execute('10', 'a1b2c3d4-0000-4000-8000-000000000001');

      expect(cardOperationAvailability.forCards).toHaveBeenCalledWith([
        { providerKey: CardProviderKey.HYPERCARD, cardProductId: null },
      ]);
    });

    describe('what was last asked of the card', () => {
      const operation = (
        overrides: Partial<CardOperationEntity> = {},
      ): Partial<CardOperationEntity> => ({
        id: '7',
        cardId: '1',
        operationType: CardLifecycleOperation.BLOCK,
        status: CardOperationStatus.SUBMITTED,
        reasonCode: null,
        message: null,
        createdAt: new Date('2026-08-24T09:00:00.000Z'),
        statusCheckedAt: null,
        ...overrides,
      });

      it('publishes a submitted block while the card still reads active', async () => {
        // The window this field exists for: the issuer has taken the request on
        // and every other field on the card is what it was before.
        cardRepository.findOne.mockResolvedValue(
          row({ id: '1', status: CardStatus.ACTIVE }),
        );
        lastOperations = [operation()];

        const card = await useCase.execute(
          '10',
          'a1b2c3d4-0000-4000-8000-000000000001',
        );

        expect(card.status).toBe(CardStatus.ACTIVE);
        expect(card.lastOperation).toEqual({
          operation: CardLifecycleOperation.BLOCK,
          status: CardOperationStatus.SUBMITTED,
          reasonCode: null,
          reason: null,
          requestedAt: new Date('2026-08-24T09:00:00.000Z'),
          lastCheckedAt: null,
        });
      });

      it('publishes a failed operation, which is the only place a partner learns of it', async () => {
        // A failed block leaves the card's own status untouched and the issuer
        // gives no reason, so the message on the row is all there is.
        cardRepository.findOne.mockResolvedValue(
          row({ id: '1', status: CardStatus.ACTIVE }),
        );
        lastOperations = [
          operation({
            status: CardOperationStatus.FAILED,
            reasonCode: 'A0005',
            message: 'the provider did not carry this out',
            statusCheckedAt: new Date('2026-08-25T09:00:00.000Z'),
          }),
        ];

        const card = await useCase.execute(
          '10',
          'a1b2c3d4-0000-4000-8000-000000000001',
        );

        expect(card.status).toBe(CardStatus.ACTIVE);
        expect(card.lastOperation).toMatchObject({
          status: CardOperationStatus.FAILED,
          reasonCode: 'A0005',
          reason: 'the provider did not carry this out',
          lastCheckedAt: new Date('2026-08-25T09:00:00.000Z'),
        });
      });

      it('is null for a card nothing was ever asked of', async () => {
        cardRepository.findOne.mockResolvedValue(row({ id: '1' }));
        lastOperations = [];

        const card = await useCase.execute(
          '10',
          'a1b2c3d4-0000-4000-8000-000000000001',
        );

        expect(card.lastOperation).toBeNull();
      });

      it('never publishes the reference or the issuer’s payload', async () => {
        cardRepository.findOne.mockResolvedValue(row({ id: '1' }));
        lastOperations = [operation()];

        const card = await useCase.execute(
          '10',
          'a1b2c3d4-0000-4000-8000-000000000001',
        );

        expect(card.lastOperation).not.toHaveProperty('requestReference');
        expect(card.lastOperation).not.toHaveProperty('responsePayload');
        expect(card.lastOperation).not.toHaveProperty('id');
      });

      it('gives each card in a page its own operation and never a neighbour’s', async () => {
        cardRepository.findAndCount.mockResolvedValue([
          [row({ id: '1' }), row({ id: '2', publicId: 'second' })],
          2,
        ]);
        lastOperations = [
          operation({
            cardId: '2',
            operationType: CardLifecycleOperation.UNBLOCK,
          }),
        ];

        const result = await useCase.listForPartner({
          partnerId: '10',
          page: 1,
          limit: 20,
        });

        expect(result.items[0]?.lastOperation).toBeNull();
        expect(result.items[1]?.lastOperation).toMatchObject({
          operation: CardLifecycleOperation.UNBLOCK,
        });
      });
    });

    it('is 404 for a card belonging to another partner', async () => {
      cardRepository.findOne.mockResolvedValue(null);

      await expect(
        useCase.execute('99', 'a1b2c3d4-0000-4000-8000-000000000001'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listing', () => {
    beforeEach(() => {
      cardRepository.findAndCount.mockResolvedValue([[row()], 1]);
    });

    const whereOf = (): Record<string, unknown> => {
      const [options] = cardRepository.findAndCount.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      return options.where;
    };

    it('projects every item the same way the member read does', async () => {
      const result = await useCase.listForPartner({
        partnerId: '10',
        page: 1,
        limit: 20,
      });

      expect(result.items[0]).toMatchObject({
        providerKey: CardProviderKey.HYPERCARD,
      });
      expect(result.items[0]).not.toHaveProperty('providerCardId');
    });

    it('carries the issuance state on every item, as the member read does', async () => {
      const result = await useCase.listForPartner({
        partnerId: '10',
        page: 1,
        limit: 20,
      });

      expect(result.items[0]).toMatchObject({
        issuance: { status: CardApplicationStatus.APPROVED },
      });
    });

    it('reads the applications for a page in one keyed query', async () => {
      cardRepository.findAndCount.mockResolvedValue([
        [row({ id: '1' }), row({ id: '2' })],
        2,
      ]);
      applicationRepository.find.mockResolvedValue([
        application({ cardId: '1' }),
        application({ id: '101', cardId: '2' }),
      ]);

      await useCase.listForPartner({ partnerId: '10', page: 1, limit: 20 });

      // One query for the page, not one per row.
      expect(applicationRepository.find).toHaveBeenCalledTimes(1);
    });

    it('reads the cardholders for a page in one keyed query', async () => {
      cardRepository.findAndCount.mockResolvedValue([
        [
          row({ id: '1', cardholderId: '20' }),
          row({ id: '2', cardholderId: '21' }),
          row({ id: '3', cardholderId: '20' }),
        ],
        3,
      ]);
      cardholderRepository.find.mockResolvedValue([
        cardholder(),
        cardholder({
          id: '21',
          publicId: 'c0000000-0000-4000-8000-000000000002',
        }),
      ]);

      await useCase.listForPartner({ partnerId: '10', page: 1, limit: 20 });

      // The card ids would satisfy the call count just as quietly.
      expect(cardholderRepository.find).toHaveBeenCalledTimes(1);
      expect(cardholderRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: In(['20', '21']) } }),
      );
    });

    it('gives each card its own cardholder and never a neighbour’s', async () => {
      cardRepository.findAndCount.mockResolvedValue([
        [
          row({ id: '1', cardholderId: '20' }),
          row({ id: '2', publicId: 'second', cardholderId: '21' }),
        ],
        2,
      ]);
      cardholderRepository.find.mockResolvedValue([
        cardholder({
          id: '21',
          publicId: 'c0000000-0000-4000-8000-000000000002',
        }),
        cardholder(),
      ]);

      const result = await useCase.listForPartner({
        partnerId: '10',
        page: 1,
        limit: 20,
      });

      // Never inherit whichever row the query returned first.
      expect(result.items[0]?.cardholderPublicId).toBe(
        'c0000000-0000-4000-8000-000000000001',
      );
      expect(result.items[1]?.cardholderPublicId).toBe(
        'c0000000-0000-4000-8000-000000000002',
      );
    });

    it('reuses the filter’s cardholder rather than reading the page’s again', async () => {
      cardholderRepository.findOne.mockResolvedValue(cardholder());
      cardRepository.findAndCount.mockResolvedValue([
        [
          row({ id: '1', cardholderId: '20' }),
          row({ id: '2', cardholderId: '20' }),
        ],
        2,
      ]);

      const result = await useCase.listForPartner({
        partnerId: '10',
        page: 1,
        limit: 20,
        cardholderPublicId: 'c0000000-0000-4000-8000-000000000001',
      });

      expect(cardholderRepository.find).not.toHaveBeenCalled();
      expect(result.items[0]?.cardholderPublicId).toBe(
        'c0000000-0000-4000-8000-000000000001',
      );
      expect(cardholderRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ select: { id: true, publicId: true } }),
      );
    });

    it('asks for no cardholders at all when the page is empty', async () => {
      cardRepository.findAndCount.mockResolvedValue([[], 0]);

      await useCase.listForPartner({ partnerId: '10', page: 1, limit: 20 });

      expect(cardholderRepository.find).not.toHaveBeenCalled();
    });

    it('asks what a whole page accepts in one call, not one per card', async () => {
      cardRepository.findAndCount.mockResolvedValue([
        [row({ id: '1' }), row({ id: '2' }), row({ id: '3' })],
        3,
      ]);
      applicationRepository.find.mockResolvedValue([
        application({ cardId: '1', cardProductId: '500' }),
        application({ id: '101', cardId: '2', cardProductId: '501' }),
        application({ id: '102', cardId: '3', cardProductId: '500' }),
      ]);

      await useCase.listForPartner({ partnerId: '10', page: 1, limit: 20 });

      expect(cardOperationAvailability.forCards).toHaveBeenCalledTimes(1);
      expect(cardOperationAvailability.forCards).toHaveBeenCalledWith([
        { providerKey: CardProviderKey.HYPERCARD, cardProductId: '500' },
        { providerKey: CardProviderKey.HYPERCARD, cardProductId: '501' },
        { providerKey: CardProviderKey.HYPERCARD, cardProductId: '500' },
      ]);
    });

    it('reads the most recent operation for a page in one query', async () => {
      cardRepository.findAndCount.mockResolvedValue([
        [row({ id: '1' }), row({ id: '2' })],
        2,
      ]);

      await useCase.listForPartner({ partnerId: '10', page: 1, limit: 20 });

      // A group-wise maximum over the whole page, never one query per row.
      expect(operationRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('carries what each card accepts on every item', async () => {
      const result = await useCase.listForPartner({
        partnerId: '10',
        page: 1,
        limit: 20,
      });

      expect(result.items[0]).toMatchObject({
        availableOperations: [CardLifecycleOperation.BLOCK],
      });
    });

    it('gives each card its own application and never a neighbour’s', async () => {
      cardRepository.findAndCount.mockResolvedValue([
        [row({ id: '1' }), row({ id: '2', publicId: 'second' })],
        2,
      ]);
      applicationRepository.find.mockResolvedValue([
        application({ cardId: '2', status: CardApplicationStatus.SUBMITTED }),
      ]);

      const result = await useCase.listForPartner({
        partnerId: '10',
        page: 1,
        limit: 20,
      });

      // Never inherit whichever row the query returned first.
      expect(result.items[0]?.issuance).toBeNull();
      expect(result.items[1]?.issuance).toMatchObject({
        status: CardApplicationStatus.SUBMITTED,
      });
    });

    it('asks for no applications at all when the page is empty', async () => {
      cardRepository.findAndCount.mockResolvedValue([[], 0]);

      await useCase.listForPartner({ partnerId: '10', page: 1, limit: 20 });

      // `IN ()` is not a query worth issuing.
      expect(applicationRepository.find).not.toHaveBeenCalled();
    });

    it('filters on the issuer when one is asked for', async () => {
      await useCase.listForPartner({
        partnerId: '10',
        page: 1,
        limit: 20,
        providerKey: CardProviderKey.AXYS,
      });

      expect(whereOf()).toEqual({
        partnerId: '10',
        providerKey: CardProviderKey.AXYS,
      });
    });

    it('leaves the issuer unconstrained when none is asked for', async () => {
      await useCase.listForPartner({ partnerId: '10', page: 1, limit: 20 });

      expect(whereOf()).toEqual({ partnerId: '10' });
    });

    it('composes the issuer with the status and cardholder filters', async () => {
      cardholderRepository.findOne.mockResolvedValue(cardholder());

      await useCase.listForPartner({
        partnerId: '10',
        page: 1,
        limit: 20,
        status: CardStatus.ACTIVE,
        cardholderPublicId: 'c0000000-0000-4000-8000-000000000001',
        providerKey: CardProviderKey.HYPERCARD,
      });

      expect(whereOf()).toEqual({
        partnerId: '10',
        status: CardStatus.ACTIVE,
        cardholderId: '20',
        providerKey: CardProviderKey.HYPERCARD,
      });
    });

    it('is 404 for a cardholder belonging to another partner', async () => {
      cardholderRepository.findOne.mockResolvedValue(null);

      await expect(
        useCase.listForPartner({
          partnerId: '10',
          page: 1,
          limit: 20,
          cardholderPublicId: 'c0000000-0000-4000-8000-000000000001',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
