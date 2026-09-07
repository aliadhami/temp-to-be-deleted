import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PartnerEntity } from '../../partners/persistence/partner.entity';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';
import { AdminGetCardUseCase } from './admin-get-card.usecase';

describe('AdminGetCardUseCase', () => {
  let useCase: AdminGetCardUseCase;
  let cardRepository: { findOne: jest.Mock; findAndCount: jest.Mock };
  let cardholderRepository: { findOne: jest.Mock };
  let partnerRepository: { findOne: jest.Mock };

  const whereOf = (): Record<string, unknown> => {
    const [options] = cardRepository.findAndCount.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    return options.where;
  };

  beforeEach(async () => {
    cardRepository = {
      findOne: jest.fn(),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    cardholderRepository = { findOne: jest.fn() };
    partnerRepository = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminGetCardUseCase,
        { provide: getRepositoryToken(CardEntity), useValue: cardRepository },
        {
          provide: getRepositoryToken(CardholderEntity),
          useValue: cardholderRepository,
        },
        {
          provide: getRepositoryToken(PartnerEntity),
          useValue: partnerRepository,
        },
      ],
    }).compile();

    useCase = module.get(AdminGetCardUseCase);
  });

  it('filters on the issuer when one is asked for', async () => {
    await useCase.listAll({
      page: 1,
      limit: 20,
      providerKey: CardProviderKey.HYPERCARD,
    });

    expect(whereOf()).toEqual({ providerKey: CardProviderKey.HYPERCARD });
  });

  it('leaves the issuer unconstrained when none is asked for', async () => {
    await useCase.listAll({ page: 1, limit: 20 });

    expect(whereOf()).toEqual({});
  });

  it('composes the issuer with every other filter', async () => {
    partnerRepository.findOne.mockResolvedValue({ id: '10' });
    cardholderRepository.findOne.mockResolvedValue({ id: '20' });

    await useCase.listAll({
      page: 1,
      limit: 20,
      status: CardStatus.ACTIVE,
      partnerPublicId: 'p0000000-0000-4000-8000-000000000001',
      cardholderPublicId: 'c0000000-0000-4000-8000-000000000001',
      providerKey: CardProviderKey.AXYS,
    });

    expect(whereOf()).toEqual({
      status: CardStatus.ACTIVE,
      partnerId: '10',
      cardholderId: '20',
      providerKey: CardProviderKey.AXYS,
    });
  });

  it('is 404 for a partner that does not exist', async () => {
    partnerRepository.findOne.mockResolvedValue(null);

    await expect(
      useCase.listAll({
        page: 1,
        limit: 20,
        partnerPublicId: 'p0000000-0000-4000-8000-000000000001',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('pages from the arguments it is given', async () => {
    await useCase.listAll({ page: 3, limit: 5 });

    expect(cardRepository.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 5 }),
    );
  });
});
