import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { HyperCardMockService } from '../infrastructure/providers/hypercard/hypercard-mock.service';
import { MockHyperCardConsumeUseCase } from './mock-hypercard-consume.usecase';

describe('MockHyperCardConsumeUseCase', () => {
  let useCase: MockHyperCardConsumeUseCase;
  let cardRepository: { findOne: jest.Mock };
  let mockService: { mockTxConsume: jest.Mock };

  const baseCard: Partial<CardEntity> = {
    id: '1',
    publicId: 'card-public-id',
    providerKey: CardProviderKey.HYPERCARD,
    providerCardId: '00003454323400000028888',
    status: CardStatus.ACTIVE,
  };

  beforeEach(async () => {
    cardRepository = { findOne: jest.fn() };
    mockService = { mockTxConsume: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MockHyperCardConsumeUseCase,
        { provide: getRepositoryToken(CardEntity), useValue: cardRepository },
        { provide: HyperCardMockService, useValue: mockService },
      ],
    }).compile();

    useCase = module.get(MockHyperCardConsumeUseCase);
    jest.clearAllMocks();
    mockService.mockTxConsume.mockResolvedValue({
      cardId: '00003454323400000028888',
      type: 1,
      status: 1,
    });
  });

  it('throws NotFoundException when the card does not exist', async () => {
    cardRepository.findOne.mockResolvedValueOnce(null);

    await expect(
      useCase.execute('missing', { amount: '10.00' }),
    ).rejects.toThrow(NotFoundException);
    expect(mockService.mockTxConsume).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the issuer holds no card id for it', async () => {
    cardRepository.findOne.mockResolvedValueOnce({
      ...baseCard,
      providerCardId: null,
    });

    await expect(
      useCase.execute('card-public-id', { amount: '10.00' }),
    ).rejects.toThrow(NotFoundException);
    expect(mockService.mockTxConsume).not.toHaveBeenCalled();
  });

  it('names another issuer before noticing there is no card id', async () => {
    cardRepository.findOne.mockResolvedValueOnce({
      ...baseCard,
      providerKey: CardProviderKey.AXYS,
      providerCardId: null,
    });

    await expect(
      useCase.execute('card-public-id', { amount: '10.00' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses a card of another issuer without calling HyperCard', async () => {
    cardRepository.findOne.mockResolvedValueOnce({
      ...baseCard,
      providerKey: CardProviderKey.AXYS,
      providerCardId: 'axys-card-id',
    });

    await expect(
      useCase.execute('card-public-id', { amount: '10.00' }),
    ).rejects.toThrow(BadRequestException);
    expect(mockService.mockTxConsume).not.toHaveBeenCalled();
  });

  it('names the issuer it refused', async () => {
    cardRepository.findOne.mockResolvedValueOnce({
      ...baseCard,
      providerKey: CardProviderKey.AXYS,
    });

    await expect(
      useCase.execute('card-public-id', { amount: '10.00' }),
    ).rejects.toThrow(/AXYS/);
  });

  it('defaults the description, fee, USD amount and date, and omits type and status', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-12T00:00:00.000Z'));
    const nowSeconds = Math.floor(Date.parse('2026-08-12T00:00:00Z') / 1000);

    try {
      cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });

      const result = await useCase.execute('card-public-id', {
        amount: '10.00',
      });

      expect(mockService.mockTxConsume).toHaveBeenCalledWith({
        cardId: '00003454323400000028888',
        description: 'admin emulation',
        fee: '0.00',
        transactionDate: nowSeconds.toString(),
        txAmount: '10.00',
        txAmountUsd: '10.00',
      });
      expect(result).toEqual({
        cardPublicId: 'card-public-id',
        amount: '10.00',
        amountUsd: '10.00',
        description: 'admin emulation',
        fee: '0.00',
        transactionDate: nowSeconds.toString(),
        type: 1,
        status: 1,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('passes every supplied value through unchanged', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    mockService.mockTxConsume.mockResolvedValueOnce({
      cardId: '00003454323400000028888',
      type: 8,
      status: 2,
    });

    const result = await useCase.execute('card-public-id', {
      amount: '11.50',
      amountUsd: '12.40',
      description: 'refund under test',
      fee: '0.25',
      transactionDate: '1595497477',
      type: 8,
      status: 2,
    });

    expect(mockService.mockTxConsume).toHaveBeenCalledWith({
      cardId: '00003454323400000028888',
      description: 'refund under test',
      fee: '0.25',
      transactionDate: '1595497477',
      txAmount: '11.50',
      txAmountUsd: '12.40',
      type: 8,
      status: 2,
    });
    expect(result).toMatchObject({
      amount: '11.50',
      amountUsd: '12.40',
      type: 8,
      status: 2,
    });
  });

  it('maps a provider conflict to a ConflictException', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    mockService.mockTxConsume.mockRejectedValueOnce(
      new CardProviderConflictError(
        CardProviderKey.HYPERCARD,
        'A0000',
        'The current card status is [Freeze] and the current operation [mock tx] is not allowed',
      ),
    );

    await expect(
      useCase.execute('card-public-id', { amount: '10.00' }),
    ).rejects.toThrow(ConflictException);
  });

  it('does not swallow the sandbox-only refusal', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    mockService.mockTxConsume.mockRejectedValueOnce(
      new ForbiddenException(
        'HyperCard mock endpoints exist only in their sandbox',
      ),
    );

    await expect(
      useCase.execute('card-public-id', { amount: '10.00' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('re-throws anything else unchanged', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    mockService.mockTxConsume.mockRejectedValueOnce(
      new Error('card service unavailable'),
    );

    await expect(
      useCase.execute('card-public-id', { amount: '10.00' }),
    ).rejects.toThrow('card service unavailable');
  });
});
