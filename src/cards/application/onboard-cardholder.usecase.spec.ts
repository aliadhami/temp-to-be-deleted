import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PartnerEntity } from '../../partners/persistence/partner.entity';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardholderStatus } from '../domain/cardholder-status.enum';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';
import { CardholderEnrolmentService } from './cardholder-enrolment.service';
import {
  OnboardCardholderInput,
  OnboardCardholderUseCase,
} from './onboard-cardholder.usecase';

describe('OnboardCardholderUseCase', () => {
  let useCase: OnboardCardholderUseCase;
  let cardholderRepository: { create: jest.Mock; save: jest.Mock };
  let partnerRepository: { findOne: jest.Mock };
  let enrolmentService: { assertCanEnrol: jest.Mock; enrol: jest.Mock };

  const input: OnboardCardholderInput = {
    partnerId: 'partner-1',
    providerKey: CardProviderKey.AXYS,
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
    identityProvenance: {
      nationality: 'British',
      placeOfBirth: 'GBR',
      gender: 1,
      callingCode: '44',
      countryCallingCode: 'GB',
      cellNumber: '1234567890',
    },
  };

  beforeEach(async () => {
    cardholderRepository = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => ({
        id: '7',
        publicId: 'ch-1',
        ...(x as object),
      })),
    };
    partnerRepository = { findOne: jest.fn() };
    enrolmentService = {
      assertCanEnrol: jest.fn(),
      enrol: jest.fn().mockResolvedValue({
        enrolment: {
          providerKey: CardProviderKey.AXYS,
          status: CardholderStatus.PENDING,
        },
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OnboardCardholderUseCase,
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

    useCase = module.get(OnboardCardholderUseCase);
    jest.clearAllMocks();
    partnerRepository.findOne.mockResolvedValue({
      id: 'partner-1',
      allowedGateways: [CardProviderKey.AXYS, CardProviderKey.HYPERCARD],
    });
    enrolmentService.assertCanEnrol.mockReturnValue({});
    enrolmentService.enrol.mockResolvedValue({
      enrolment: {
        providerKey: CardProviderKey.AXYS,
        status: CardholderStatus.PENDING,
      },
    });
  });

  it('throws NotFoundException for an unknown partner', async () => {
    partnerRepository.findOne.mockResolvedValueOnce(null);

    await expect(useCase.execute(input)).rejects.toThrow(NotFoundException);
    expect(cardholderRepository.save).not.toHaveBeenCalled();
  });

  it('writes no cardholder row when the issuer is refused', async () => {
    // The reason the gate sits above the create/save rather than below it: a
    // refusal after the write leaves a person with no enrolment, which no read
    // reaches and no sweep collects — carrying the identity material the
    // partner sent.
    enrolmentService.assertCanEnrol.mockImplementation(() => {
      throw new ForbiddenException();
    });

    await expect(useCase.execute(input)).rejects.toThrow(ForbiddenException);

    expect(cardholderRepository.create).not.toHaveBeenCalled();
    expect(cardholderRepository.save).not.toHaveBeenCalled();
    expect(enrolmentService.enrol).not.toHaveBeenCalled();
  });

  it('checks the issuer before it writes, not after', async () => {
    // Ordering, asserted directly: a future edit that moves the guard below
    // the insert passes every other case in this file.
    const order: string[] = [];
    enrolmentService.assertCanEnrol.mockImplementation(() => {
      order.push('assert');
      return {};
    });
    cardholderRepository.save.mockImplementation((row: unknown) => {
      order.push('save');
      return { id: '7', publicId: 'ch-1', ...(row as object) };
    });

    await useCase.execute(input);

    expect(order).toEqual(['assert', 'save']);
  });

  it('records the person and puts them to the requested issuer', async () => {
    const result = await useCase.execute(input);

    expect(cardholderRepository.save).toHaveBeenCalled();
    expect(enrolmentService.enrol).toHaveBeenCalledWith(
      expect.objectContaining({ publicId: 'ch-1' }),
      expect.objectContaining({ id: 'partner-1' }),
      CardProviderKey.AXYS,
    );
    expect(result).toEqual({
      publicId: 'ch-1',
      providerKey: CardProviderKey.AXYS,
      status: CardholderStatus.PENDING,
    });
  });

  it('writes no issuer or status onto the person', async () => {
    // Those are per-issuer and belong to the enrolment. A copy here would be a
    // second answer to a question one issuer does not get to settle.
    await useCase.execute(input);

    const [row] = cardholderRepository.create.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(row).not.toHaveProperty('providerKey');
    expect(row).not.toHaveProperty('status');
  });

  it('stores a blank IP as absent rather than as an empty string', async () => {
    await useCase.execute({ ...input, userIp: '   ' });

    expect(cardholderRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ userIp: null }),
    );
  });

  it('returns the KYC url when the issuer minted one', async () => {
    enrolmentService.enrol.mockResolvedValueOnce({
      enrolment: {
        providerKey: CardProviderKey.AXYS,
        status: CardholderStatus.PENDING,
      },
      kycUrl: 'https://kyc.example.com/one-shot',
    });

    await expect(useCase.execute(input)).resolves.toEqual(
      expect.objectContaining({ kycUrl: 'https://kyc.example.com/one-shot' }),
    );
  });
});
