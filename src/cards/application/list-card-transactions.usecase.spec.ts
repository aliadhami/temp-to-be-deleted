import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CardCapability } from '../domain/card-capability.enum';
import { CardProviderIntentRejectedError } from '../domain/card-provider-intent-rejected.error';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { ListCardTransactionsUseCase } from './list-card-transactions.usecase';

describe('ListCardTransactionsUseCase', () => {
  let useCase: ListCardTransactionsUseCase;
  let cardRepository: { findOne: jest.Mock };
  let cardIssuerRegistry: { resolve: jest.Mock };

  const adapter = {
    capabilities: new Set([CardCapability.TRANSACTIONS_READ]),
    getCardTransactions: jest.fn(),
  };

  const baseCard: Partial<CardEntity> = {
    id: '1',
    publicId: 'card-public-id',
    partnerId: 'partner-1',
    providerKey: CardProviderKey.AXYS,
    providerCardId: 'axys-card-id',
    status: CardStatus.ACTIVE,
  };

  beforeEach(async () => {
    cardRepository = { findOne: jest.fn() };
    cardIssuerRegistry = { resolve: jest.fn(() => adapter) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListCardTransactionsUseCase,
        { provide: getRepositoryToken(CardEntity), useValue: cardRepository },
        { provide: CardIssuerRegistry, useValue: cardIssuerRegistry },
      ],
    }).compile();

    useCase = module.get(ListCardTransactionsUseCase);
    jest.clearAllMocks();
    cardIssuerRegistry.resolve.mockReturnValue(adapter);
  });

  it('throws NotFoundException when the card does not belong to this partner', async () => {
    cardRepository.findOne.mockResolvedValueOnce(null);
    await expect(useCase.execute('partner-1', 'missing', {})).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws ForbiddenException when the provider lacks TRANSACTIONS_READ capability', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    cardIssuerRegistry.resolve.mockReturnValueOnce({
      capabilities: new Set(),
      getCardTransactions: jest.fn(),
    });
    await expect(
      useCase.execute('partner-1', 'card-public-id', {}),
    ).rejects.toThrow(ForbiddenException);
  });

  it('forwards pagination params to the adapter and returns items with next_cursor', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    adapter.getCardTransactions.mockResolvedValueOnce({
      items: [
        {
          id: 'txn_abc',
          amount: '14.99',
          currencyCode: 'USD',
          status: 'settled',
          category: 'authorization',
          merchantName: 'Blue Bottle',
          merchantAmount: '14.99',
          merchantCurrency: 'USD',
          createdAt: '2026-07-08T12:00:00.000Z',
          settledAt: '2026-07-08T12:00:00.000Z',
        },
      ],
      nextCursor: 'cursor-abc',
    });

    const params = { limit: 10, before: 1700000000, after: 1690000000 };
    const result = await useCase.execute('partner-1', 'card-public-id', params);

    expect(adapter.getCardTransactions).toHaveBeenCalledWith(
      'axys-card-id',
      params,
      {},
    );
    expect(result).toEqual({
      cardPublicId: 'card-public-id',
      items: [
        {
          id: 'txn_abc',
          amount: '14.99',
          currencyCode: 'USD',
          status: 'settled',
          category: 'authorization',
          merchantName: 'Blue Bottle',
          merchantAmount: '14.99',
          merchantCurrency: 'USD',
          createdAt: '2026-07-08T12:00:00.000Z',
          settledAt: '2026-07-08T12:00:00.000Z',
        },
      ],
      nextCursor: 'cursor-abc',
    });
  });

  it('answers a refusal the partner can act on with a 400, not a server fault', async () => {
    // An issuer's statement covers a bounded range and pages on its own terms,
    // so an adapter can tell before calling that a range or a continuation
    // token will not be served.
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    adapter.getCardTransactions.mockRejectedValueOnce(
      new CardProviderIntentRejectedError(
        CardProviderKey.AXYS,
        'after',
        'the range is wider than the issuer serves',
      ),
    );

    await expect(
      useCase.execute('partner-1', 'card-public-id', {}),
    ).rejects.toThrow(BadRequestException);
  });

  it('lets anything else through, so a provider fault is not reported as bad input', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    adapter.getCardTransactions.mockRejectedValueOnce(
      new Error('the issuer is down'),
    );

    await expect(
      useCase.execute('partner-1', 'card-public-id', {}),
    ).rejects.toThrow('the issuer is down');
  });
});
