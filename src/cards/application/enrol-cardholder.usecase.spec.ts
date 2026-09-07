import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PartnerEntity } from '../../partners/persistence/partner.entity';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardholderStatus } from '../domain/cardholder-status.enum';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';
import { CardholderEnrolmentService } from './cardholder-enrolment.service';
import { EnrolCardholderUseCase } from './enrol-cardholder.usecase';

describe('EnrolCardholderUseCase', () => {
  let useCase: EnrolCardholderUseCase;
  let cardholderRepository: { findOne: jest.Mock };
  let partnerRepository: { findOne: jest.Mock };
  let enrolmentService: { enrol: jest.Mock };

  const input = {
    partnerId: 'partner-1',
    cardholderPublicId: 'ch-1',
    providerKey: CardProviderKey.HYPERCARD,
  };

  beforeEach(async () => {
    cardholderRepository = { findOne: jest.fn() };
    partnerRepository = { findOne: jest.fn() };
    enrolmentService = { enrol: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnrolCardholderUseCase,
        {
          provide: getRepositoryToken(CardholderEntity),
          useValue: cardholderRepository,
        },
        {
          provide: getRepositoryToken(PartnerEntity),
          useValue: partnerRepository,
        },
        { provide: CardholderEnrolmentService, useValue: enrolmentService },
      ],
    }).compile();

    useCase = module.get(EnrolCardholderUseCase);
    jest.clearAllMocks();
    cardholderRepository.findOne.mockResolvedValue({
      id: '7',
      publicId: 'ch-1',
      partnerId: 'partner-1',
    });
    partnerRepository.findOne.mockResolvedValue({
      id: 'partner-1',
      allowedGateways: [CardProviderKey.AXYS, CardProviderKey.HYPERCARD],
    });
    enrolmentService.enrol.mockResolvedValue({
      enrolment: {
        providerKey: CardProviderKey.HYPERCARD,
        status: CardholderStatus.APPROVED,
      },
    });
  });

  it('scopes the lookup to the calling partner', async () => {
    await useCase.execute(input);

    expect(cardholderRepository.findOne).toHaveBeenCalledWith({
      where: { publicId: 'ch-1', partnerId: 'partner-1' },
    });
  });

  it('throws NotFoundException for a cardholder the partner does not hold', async () => {
    cardholderRepository.findOne.mockResolvedValueOnce(null);

    await expect(useCase.execute(input)).rejects.toThrow(NotFoundException);
    expect(enrolmentService.enrol).not.toHaveBeenCalled();
  });

  it('puts the existing person to the further issuer', async () => {
    const result = await useCase.execute(input);

    expect(enrolmentService.enrol).toHaveBeenCalledWith(
      expect.objectContaining({ id: '7' }),
      expect.objectContaining({ id: 'partner-1' }),
      CardProviderKey.HYPERCARD,
    );
    expect(result).toEqual({
      publicId: 'ch-1',
      providerKey: CardProviderKey.HYPERCARD,
      status: CardholderStatus.APPROVED,
    });
  });
});
