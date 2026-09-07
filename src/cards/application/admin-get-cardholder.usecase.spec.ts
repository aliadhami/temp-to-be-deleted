import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PartnerEntity } from '../../partners/persistence/partner.entity';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';
import { AdminGetCardholderUseCase } from './admin-get-cardholder.usecase';

describe('AdminGetCardholderUseCase', () => {
  let useCase: AdminGetCardholderUseCase;
  let cardholderRepository: {
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let partnerRepository: { findOne: jest.Mock };
  // Typed member by member rather than as a Record: under
  // `noUncheckedIndexedAccess` an index lookup is possibly-undefined.
  let query: {
    leftJoinAndSelect: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    getManyAndCount: jest.Mock;
  };

  beforeEach(async () => {
    query = {
      leftJoinAndSelect: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      skip: jest.fn(),
      take: jest.fn(),
      getManyAndCount: jest.fn(),
    };
    for (const method of Object.values(query)) method.mockReturnValue(query);
    query.getManyAndCount.mockResolvedValue([[], 0]);

    cardholderRepository = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => query),
    };
    partnerRepository = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminGetCardholderUseCase,
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

    useCase = module.get(AdminGetCardholderUseCase);
  });

  it('joins the enrolments, which carry the issuer and the status', async () => {
    await useCase.listAll({ page: 1, limit: 20 });

    expect(query.leftJoinAndSelect).toHaveBeenCalledWith(
      'cardholder.enrolments',
      'enrolments',
    );
  });

  it('constrains nothing when no filter is asked for', async () => {
    await useCase.listAll({ page: 1, limit: 20 });

    expect(query.andWhere).not.toHaveBeenCalled();
  });

  it('narrows to one partner when one is named', async () => {
    partnerRepository.findOne.mockResolvedValue({ id: '10' });

    await useCase.listAll({
      page: 1,
      limit: 20,
      partnerPublicId: 'p0000000-0000-4000-8000-000000000001',
    });

    expect(query.andWhere).toHaveBeenCalledWith(
      'cardholder.partner_id = :partnerId',
      { partnerId: '10' },
    );
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

    expect(query.skip).toHaveBeenCalledWith(10);
    expect(query.take).toHaveBeenCalledWith(5);
  });

  it('loads the enrolments on the member read too', async () => {
    cardholderRepository.findOne.mockResolvedValue({ id: '1' });

    await useCase.getByPublicId('c0000000-0000-4000-8000-000000000001');

    expect(cardholderRepository.findOne).toHaveBeenCalledWith({
      where: { publicId: 'c0000000-0000-4000-8000-000000000001' },
      relations: { enrolments: true },
    });
  });

  it('is 404 for a cardholder that does not exist', async () => {
    cardholderRepository.findOne.mockResolvedValue(null);

    await expect(useCase.getByPublicId('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
