import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CardCapability } from '../domain/card-capability.enum';
import { CardFundingQuoteResult } from '../domain/card-issuer.port';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { CardProviderIntentRejectedError } from '../domain/card-provider-intent-rejected.error';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { FundingNetwork } from '../domain/funding-network.enum';
import { CardDepositProduct } from './card-product-resolver';
import { QuoteCardDepositUseCase } from './quote-card-deposit.usecase';

describe('QuoteCardDepositUseCase', () => {
  let useCase: QuoteCardDepositUseCase;
  let findOne: jest.Mock;
  let resolveForCard: jest.Mock;
  let quoteCardFunding: jest.Mock;
  let capabilities: Set<CardCapability>;
  let warn: jest.SpyInstance;

  const card = (overrides: Record<string, unknown> = {}) => ({
    id: '5',
    publicId: 'card-1',
    providerKey: CardProviderKey.HYPERCARD,
    ...overrides,
  });

  const product = (
    overrides: Partial<CardDepositProduct> = {},
  ): CardDepositProduct => ({
    publicId: 'product-1',
    providerProductId: '52400002',
    currencyCode: 'USD',
    depositMinPerTransaction: '10',
    depositMaxPerTransaction: '100000',
    ...overrides,
  });

  /**
   * `satisfies` rather than a bare object: the adapter mock is untyped, so
   * without it a case would pass against a stale port type.
   */
  const quoteResult = (
    overrides: Partial<CardFundingQuoteResult> = {},
  ): CardFundingQuoteResult =>
    ({
      credited: { amount: '100.00000000', currencyCode: 'USD' },
      cost: { amount: '102.71614508', currencyCode: 'USDT' },
      fee: { amount: '0.88', currencyCode: 'USDT' },
      quotedAt: '2026-02-03T04:05:06.789Z',
      ...overrides,
    }) satisfies CardFundingQuoteResult;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    findOne = jest.fn().mockResolvedValue(card());
    resolveForCard = jest.fn().mockResolvedValue(product());
    quoteCardFunding = jest.fn().mockResolvedValue(quoteResult());
    capabilities = new Set([CardCapability.FUNDING_QUOTE]);

    useCase = new QuoteCardDepositUseCase(
      { findOne } as never,
      {
        resolveForCard,
      } as never,
      {
        resolve: jest.fn(() => ({ capabilities, quoteCardFunding })),
      } as never,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  const execute = (
    overrides: Partial<Parameters<QuoteCardDepositUseCase['execute']>[0]> = {},
  ) =>
    useCase.execute({
      partnerId: 'partner-1',
      cardPublicId: 'card-1',
      amount: '100',
      ...overrides,
    });

  it("asks the issuer for the card's product and the fiat amount", async () => {
    await execute();

    expect(quoteCardFunding).toHaveBeenCalledWith(
      '52400002',
      { depositAmount: '100', currencyCode: 'USD' },
      {},
    );
  });

  it('looks the card up scoped to the calling partner', async () => {
    await execute();

    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { publicId: 'card-1', partnerId: 'partner-1' },
      }),
    );
  });

  it("answers a card that is not the partner's as not found", async () => {
    findOne.mockResolvedValue(null);

    await expect(execute()).rejects.toThrow(NotFoundException);
    expect(quoteCardFunding).not.toHaveBeenCalled();
  });

  it('publishes the cost and the fee the issuer quoted', async () => {
    const quote = await execute();

    expect(quote.cardPublicId).toBe('card-1');
    expect(quote.credited).toEqual({
      amount: '100.00000000',
      currencyCode: 'USD',
    });
    expect(quote.depositCost).toEqual({
      amount: '102.71614508',
      currencyCode: 'USDT',
    });
    expect(quote.depositFee).toEqual({ amount: '0.88', currencyCode: 'USDT' });
    expect(quote.quotedAt).toBe('2026-02-03T04:05:06.789Z');
  });

  it('carries no card fee and no total', async () => {
    const quote = await execute();

    expect(quote).not.toHaveProperty('issuanceFee');
    expect(quote).not.toHaveProperty('total');
  });

  it('rounds the payable figure up from the deposit cost alone', async () => {
    const quote = await execute({ network: FundingNetwork.TRON });

    expect(quote.payable).toEqual({
      amount: '102.716146',
      currencyCode: 'USDT',
      network: FundingNetwork.TRON,
      decimals: 6,
    });
  });

  it('answers a figure payable on every chain when none is named', async () => {
    const quote = await execute();

    expect(quote.payable).toEqual({
      amount: '102.716146',
      currencyCode: 'USDT',
      network: null,
      decimals: 6,
    });
  });

  it('publishes no payable figure for a coin no supported chain holds', async () => {
    quoteCardFunding.mockResolvedValue(
      quoteResult({
        cost: { amount: '1', currencyCode: 'BTC' },
        fee: { amount: '0', currencyCode: 'BTC' },
      }),
    );

    const quote = await execute();

    expect(quote.depositCost).toEqual({ amount: '1', currencyCode: 'BTC' });
    expect(quote.payable).toBeNull();
  });

  it('refuses a card with no product recorded, before calling', async () => {
    resolveForCard.mockResolvedValue(null);

    await expect(execute()).rejects.toThrow(ConflictException);
    expect(quoteCardFunding).not.toHaveBeenCalled();
  });

  it('refuses an issuer that does not declare the capability, before reading the product', async () => {
    capabilities.clear();

    await expect(execute()).rejects.toThrow(ForbiddenException);
    expect(resolveForCard).not.toHaveBeenCalled();
    expect(quoteCardFunding).not.toHaveBeenCalled();
  });

  it("refuses an amount below the product's per-transaction minimum, before calling", async () => {
    await expect(execute({ amount: '9.99999999' })).rejects.toThrow(
      BadRequestException,
    );
    expect(quoteCardFunding).not.toHaveBeenCalled();
  });

  it("refuses an amount above the product's per-transaction maximum, before calling", async () => {
    await expect(execute({ amount: '100000.00000001' })).rejects.toThrow(
      BadRequestException,
    );
    expect(quoteCardFunding).not.toHaveBeenCalled();
  });

  it('prices a card that is not active', async () => {
    findOne.mockResolvedValue(card({ status: CardStatus.NOT_ACTIVATED }));

    await expect(execute()).resolves.toBeDefined();
  });

  it('prices against a product the issuer has withdrawn from issuance', async () => {
    await expect(execute()).resolves.toBeDefined();
  });

  it("turns an issuer's refusal into a conflict carrying none of their text", async () => {
    quoteCardFunding.mockRejectedValue(
      new CardProviderConflictError(
        CardProviderKey.HYPERCARD,
        'A0010',
        'HyperCard refused card funding estimate: This card does not support recharging',
      ),
    );

    await expect(execute()).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        message: expect.not.stringContaining('A0010') as unknown,
      }) as unknown,
    });
  });

  it("answers a refused value naming this route's own field", async () => {
    quoteCardFunding.mockRejectedValue(
      new CardProviderIntentRejectedError(
        CardProviderKey.HYPERCARD,
        'initialDepositAmount',
        'the issuer would not price this deposit',
      ),
    );

    await expect(execute()).rejects.toThrow(BadRequestException);
    await expect(execute()).rejects.toThrow('"amount"');
  });

  it('warns when the issuer priced a different top-up from the one asked about', async () => {
    quoteCardFunding.mockResolvedValue(
      quoteResult({ credited: { amount: '95', currencyCode: 'USD' } }),
    );

    const quote = await execute();

    expect(quote.credited.amount).toBe('95');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('against a requested top-up of 100'),
    );
  });

  it('lets an unrecognised provider failure through unchanged', async () => {
    const failure = new Error('connection reset');
    quoteCardFunding.mockRejectedValue(failure);

    await expect(execute()).rejects.toBe(failure);
  });
});
