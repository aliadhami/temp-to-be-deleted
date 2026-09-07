import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardholderStatus } from '../domain/cardholder-status.enum';
import { CardholderEnrolmentEntity } from '../infrastructure/persistence/cardholder-enrolment.entity';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';
import { CardholderEnrolmentResolver } from './cardholder-enrolment.resolver';
import { GetCardholderUseCase } from './get-cardholder.usecase';

describe('GetCardholderUseCase', () => {
  let useCase: GetCardholderUseCase;
  let cardholderRepository: {
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let enrolmentRepository: { find: jest.Mock };
  let enrolmentResolver: { listFor: jest.Mock };
  // Typed member by member rather than as a Record: under
  // `noUncheckedIndexedAccess` an index lookup is possibly-undefined and every
  // `query.take` below would need a guard.
  let query: {
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    getManyAndCount: jest.Mock;
  };

  const row = (overrides: Partial<CardholderEntity> = {}): CardholderEntity =>
    ({
      id: '1',
      publicId: 'c0000000-0000-4000-8000-000000000001',
      partnerId: '10',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      phone: '+441234567890',
      dateOfBirth: '1815-12-10',
      residentialAddress: {
        addressLine1: '1 Main St',
        city: 'London',
        country: 'GB',
      },
      identityProvenance: { nationality: 'British' },
      userIp: '40.77.166.66',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      ...overrides,
    }) as CardholderEntity;

  const enrolment = (
    providerKey: CardProviderKey,
    status: CardholderStatus,
  ): CardholderEnrolmentEntity =>
    ({
      id: '11',
      cardholderId: '1',
      providerKey,
      providerCardholderId: 'issuer-holder-1',
      status,
      reasonCode: null,
      message: null,
      responsePayload: { their: 'payload' },
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }) as unknown as CardholderEnrolmentEntity;

  beforeEach(async () => {
    query = {
      where: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      skip: jest.fn(),
      take: jest.fn(),
      getManyAndCount: jest.fn().mockResolvedValue([[row()], 1]),
    };
    for (const method of Object.values(query)) method.mockReturnValue(query);
    query.getManyAndCount.mockResolvedValue([[row()], 1]);

    cardholderRepository = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => query),
    };
    enrolmentRepository = {
      find: jest
        .fn()
        .mockResolvedValue([
          enrolment(CardProviderKey.HYPERCARD, CardholderStatus.APPROVED),
        ]),
    };
    enrolmentResolver = {
      listFor: jest
        .fn()
        .mockResolvedValue([
          enrolment(CardProviderKey.HYPERCARD, CardholderStatus.APPROVED),
          enrolment(CardProviderKey.AXYS, CardholderStatus.PENDING),
        ]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetCardholderUseCase,
        {
          provide: getRepositoryToken(CardholderEntity),
          useValue: cardholderRepository,
        },
        {
          provide: getRepositoryToken(CardholderEnrolmentEntity),
          useValue: enrolmentRepository,
        },
        {
          provide: CardholderEnrolmentResolver,
          useValue: enrolmentResolver,
        },
      ],
    }).compile();

    useCase = module.get(GetCardholderUseCase);
  });

  describe('the cardholder a partner reads back', () => {
    it('publishes one standing per issuer rather than a single status', async () => {
      cardholderRepository.findOne.mockResolvedValue(row());

      const cardholder = await useCase.execute(
        '10',
        'c0000000-0000-4000-8000-000000000001',
      );

      expect(cardholder.enrolments).toEqual([
        expect.objectContaining({
          providerKey: CardProviderKey.HYPERCARD,
          status: CardholderStatus.APPROVED,
        }),
        expect.objectContaining({
          providerKey: CardProviderKey.AXYS,
          status: CardholderStatus.PENDING,
        }),
      ]);
    });

    it('carries no top-level issuer or status', async () => {
      // Reading one status for a person is the thing that let an approval from
      // one issuer stand in for every issuer.
      cardholderRepository.findOne.mockResolvedValue(row());

      const cardholder = await useCase.execute(
        '10',
        'c0000000-0000-4000-8000-000000000001',
      );

      expect(cardholder).not.toHaveProperty('providerKey');
      expect(cardholder).not.toHaveProperty('status');
    });

    it('carries neither the issuer’s own identifier nor the identity material', async () => {
      cardholderRepository.findOne.mockResolvedValue(row());

      const cardholder = await useCase.execute(
        '10',
        'c0000000-0000-4000-8000-000000000001',
      );

      // The issuer's own identifier for the person is not a partner-facing
      // fact, and neither is anything the partner already holds about them.
      expect(cardholder).not.toHaveProperty('id');
      expect(cardholder).not.toHaveProperty('partnerId');
      expect(cardholder).not.toHaveProperty('residentialAddress');
      expect(cardholder).not.toHaveProperty('identityProvenance');
      expect(cardholder).not.toHaveProperty('dateOfBirth');
      expect(cardholder).not.toHaveProperty('userIp');
      expect(cardholder.enrolments[0]).not.toHaveProperty(
        'providerCardholderId',
      );
      expect(cardholder.enrolments[0]).not.toHaveProperty('responsePayload');
    });

    it('is 404 for a cardholder belonging to another partner', async () => {
      cardholderRepository.findOne.mockResolvedValue(null);

      await expect(
        useCase.execute('99', 'c0000000-0000-4000-8000-000000000001'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listing', () => {
    it('scopes to the calling partner', async () => {
      await useCase.listForPartner({ partnerId: '10', page: 1, limit: 20 });

      expect(query.where).toHaveBeenCalledWith(
        'cardholder.partner_id = :partnerId',
        { partnerId: '10' },
      );
    });

    it('projects every item the same way the member read does', async () => {
      const result = await useCase.listForPartner({
        partnerId: '10',
        page: 1,
        limit: 20,
      });

      expect(result.items[0]?.enrolments).toEqual([
        expect.objectContaining({ providerKey: CardProviderKey.HYPERCARD }),
      ]);
      expect(result.items[0]).not.toHaveProperty('providerKey');
    });

    it('loads the page’s enrolments in one query rather than one per row', async () => {
      query.getManyAndCount.mockResolvedValue([
        [row(), row({ id: '2', publicId: 'other' })],
        2,
      ]);

      await useCase.listForPartner({ partnerId: '10', page: 1, limit: 20 });

      expect(enrolmentRepository.find).toHaveBeenCalledTimes(1);
    });

    it('asks for no enrolments when the page is empty', async () => {
      query.getManyAndCount.mockResolvedValue([[], 0]);

      await useCase.listForPartner({ partnerId: '10', page: 1, limit: 20 });

      expect(enrolmentRepository.find).not.toHaveBeenCalled();
    });

    it('pages from the arguments it is given', async () => {
      await useCase.listForPartner({ partnerId: '10', page: 3, limit: 5 });

      expect(query.skip).toHaveBeenCalledWith(10);
      expect(query.take).toHaveBeenCalledWith(5);
    });
  });
});
