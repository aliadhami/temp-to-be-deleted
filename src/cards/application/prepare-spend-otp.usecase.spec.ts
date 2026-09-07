import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { AxysEmulationService } from '../infrastructure/providers/axys/axys-emulation.service';
import { PrepareSpendOtpUseCase } from './prepare-spend-otp.usecase';

describe('PrepareSpendOtpUseCase', () => {
  let useCase: PrepareSpendOtpUseCase;
  let cardRepository: { findOne: jest.Mock };
  let axysEmulationService: { prepareSpendOtp: jest.Mock };

  const baseCard: Partial<CardEntity> = {
    id: '1',
    publicId: 'card-public-id',
    providerKey: CardProviderKey.AXYS,
    providerCardId: 'axys-card-id',
    status: CardStatus.ACTIVE,
  };

  beforeEach(async () => {
    cardRepository = { findOne: jest.fn() };
    axysEmulationService = { prepareSpendOtp: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrepareSpendOtpUseCase,
        { provide: getRepositoryToken(CardEntity), useValue: cardRepository },
        { provide: AxysEmulationService, useValue: axysEmulationService },
      ],
    }).compile();

    useCase = module.get(PrepareSpendOtpUseCase);
    jest.clearAllMocks();
  });

  it('throws NotFoundException when the card does not exist', async () => {
    cardRepository.findOne.mockResolvedValueOnce(null);
    await expect(useCase.execute('missing')).rejects.toThrow(NotFoundException);
    expect(axysEmulationService.prepareSpendOtp).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the card has no providerCardId', async () => {
    cardRepository.findOne.mockResolvedValueOnce({
      ...baseCard,
      providerCardId: null,
    });
    await expect(useCase.execute('card-public-id')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('returns the generated pin alongside the card public id', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    axysEmulationService.prepareSpendOtp.mockResolvedValueOnce({
      pin: '123456',
    });

    const result = await useCase.execute('card-public-id');

    expect(axysEmulationService.prepareSpendOtp).toHaveBeenCalledWith(
      'axys-card-id',
      expect.stringMatching(/^spend-otp-card-public-id-[0-9a-f]{8}$/),
    );
    expect(result).toEqual({ cardPublicId: 'card-public-id', pin: '123456' });
  });

  it('maps a provider conflict to a ConflictException, since no listener can ever be registered today', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    axysEmulationService.prepareSpendOtp.mockRejectedValueOnce(
      new CardProviderConflictError(
        CardProviderKey.AXYS,
        'INVALID_STATE_TRANSITION',
        'no pending listener',
      ),
    );

    await expect(useCase.execute('card-public-id')).rejects.toThrow(
      ConflictException,
    );
  });

  it('re-throws non-409 errors from the emulation service unchanged', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    axysEmulationService.prepareSpendOtp.mockRejectedValueOnce(
      new Error('card service unavailable'),
    );

    await expect(useCase.execute('card-public-id')).rejects.toThrow(
      'card service unavailable',
    );
  });
});
