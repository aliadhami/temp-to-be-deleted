import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { AxysEmulationService } from '../infrastructure/providers/axys/axys-emulation.service';
import { SimulateCardSpendUseCase } from './simulate-card-spend.usecase';

describe('SimulateCardSpendUseCase', () => {
  let useCase: SimulateCardSpendUseCase;
  let cardRepository: { findOne: jest.Mock };
  let axysEmulationService: { simulateSpend: jest.Mock };

  const baseCard: Partial<CardEntity> = {
    id: '1',
    publicId: 'card-public-id',
    providerKey: CardProviderKey.AXYS,
    providerCardId: 'axys-card-id',
    status: CardStatus.ACTIVE,
  };

  beforeEach(async () => {
    cardRepository = { findOne: jest.fn() };
    axysEmulationService = { simulateSpend: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SimulateCardSpendUseCase,
        { provide: getRepositoryToken(CardEntity), useValue: cardRepository },
        { provide: AxysEmulationService, useValue: axysEmulationService },
      ],
    }).compile();

    useCase = module.get(SimulateCardSpendUseCase);
    jest.clearAllMocks();
  });

  it('throws NotFoundException when the card does not exist', async () => {
    cardRepository.findOne.mockResolvedValueOnce(null);
    await expect(useCase.execute('missing', '10.00')).rejects.toThrow(
      NotFoundException,
    );
    expect(axysEmulationService.simulateSpend).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the card has no providerCardId', async () => {
    cardRepository.findOne.mockResolvedValueOnce({
      ...baseCard,
      providerCardId: null,
    });
    await expect(useCase.execute('card-public-id', '10.00')).rejects.toThrow(
      NotFoundException,
    );
    expect(axysEmulationService.simulateSpend).not.toHaveBeenCalled();
  });

  it('calls simulateSpend with the provider card id, amount, and a fresh idempotency key', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    axysEmulationService.simulateSpend.mockResolvedValueOnce(undefined);

    const result = await useCase.execute('card-public-id', '10.00');

    expect(axysEmulationService.simulateSpend).toHaveBeenCalledWith(
      'axys-card-id',
      '10.00',
      expect.stringMatching(/^spend-card-public-id-[0-9a-f]{8}$/),
    );
    expect(result).toEqual({ cardPublicId: 'card-public-id', amount: '10.00' });
  });

  it('maps a provider conflict to a ConflictException', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    axysEmulationService.simulateSpend.mockRejectedValueOnce(
      new CardProviderConflictError(
        CardProviderKey.AXYS,
        'INVALID_STATE_TRANSITION',
        'not active or insufficient funds',
      ),
    );

    await expect(useCase.execute('card-public-id', '10.00')).rejects.toThrow(
      ConflictException,
    );
  });

  it('re-throws non-409 errors from the emulation service unchanged', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    axysEmulationService.simulateSpend.mockRejectedValueOnce(
      new Error('card service unavailable'),
    );

    await expect(useCase.execute('card-public-id', '10.00')).rejects.toThrow(
      'card service unavailable',
    );
  });
});
