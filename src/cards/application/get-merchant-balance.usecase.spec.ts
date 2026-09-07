import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CardCapability } from '../domain/card-capability.enum';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardProviderUnsupportedOperationError } from '../domain/card-provider-unsupported-operation.error';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { GetMerchantBalanceUseCase } from './get-merchant-balance.usecase';

describe('GetMerchantBalanceUseCase', () => {
  let useCase: GetMerchantBalanceUseCase;
  let registry: { resolve: jest.Mock };
  let issuer: {
    capabilities: Set<CardCapability>;
    getMerchantBalance: jest.Mock;
  };

  const float = {
    entries: [
      { currencyCode: 'USDT', available: '100.00', ledger: '100.888888' },
    ],
    observedAt: '2026-02-03T04:05:06.789Z',
  };

  beforeEach(async () => {
    issuer = {
      capabilities: new Set([CardCapability.MERCHANT_BALANCE_READ]),
      getMerchantBalance: jest.fn().mockResolvedValue(float),
    };
    registry = { resolve: jest.fn().mockReturnValue(issuer) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetMerchantBalanceUseCase,
        { provide: CardIssuerRegistry, useValue: registry },
      ],
    }).compile();

    useCase = module.get(GetMerchantBalanceUseCase);
  });

  it('answers with the provider it was asked about alongside the float', async () => {
    const result = await useCase.execute(CardProviderKey.HYPERCARD);

    expect(registry.resolve).toHaveBeenCalledWith(CardProviderKey.HYPERCARD);
    expect(result).toEqual({
      providerKey: CardProviderKey.HYPERCARD,
      ...float,
    });
  });

  it('sends no credentials — a float is neither a card’s nor a partner’s', async () => {
    await useCase.execute(CardProviderKey.HYPERCARD);

    expect(issuer.getMerchantBalance).toHaveBeenCalledWith({});
  });

  it('refuses an issuer that declares no merchant balance, without calling it', async () => {
    issuer.capabilities = new Set();

    await expect(useCase.execute(CardProviderKey.AXYS)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(issuer.getMerchantBalance).not.toHaveBeenCalled();
  });

  it('names the provider in the refusal', async () => {
    issuer.capabilities = new Set();

    await expect(useCase.execute(CardProviderKey.AXYS)).rejects.toThrow(/AXYS/);
  });

  it('lets the registry refuse a provider that is not enabled', async () => {
    registry.resolve.mockImplementation(() => {
      throw new BadRequestException('Card provider "AXYS" is not enabled');
    });

    await expect(useCase.execute(CardProviderKey.AXYS)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('propagates an issuer’s own refusal unchanged', async () => {
    issuer.getMerchantBalance.mockRejectedValueOnce(
      new CardProviderUnsupportedOperationError(
        CardProviderKey.AXYS,
        'getMerchantBalance',
        'no account exists',
      ),
    );

    await expect(useCase.execute(CardProviderKey.AXYS)).rejects.toBeInstanceOf(
      CardProviderUnsupportedOperationError,
    );
  });

  it('propagates a transport failure rather than reporting an empty float', async () => {
    issuer.getMerchantBalance.mockRejectedValueOnce(
      new Error('the issuer is unreachable'),
    );

    await expect(useCase.execute(CardProviderKey.HYPERCARD)).rejects.toThrow(
      'the issuer is unreachable',
    );
  });

  it('reports an empty float as an answer', async () => {
    issuer.getMerchantBalance.mockResolvedValueOnce({
      entries: [],
      observedAt: float.observedAt,
    });

    const result = await useCase.execute(CardProviderKey.HYPERCARD);

    expect(result.entries).toEqual([]);
  });
});
