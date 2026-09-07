import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { CardCapability } from '../domain/card-capability.enum';
import { CardFundingQuoteResult } from '../domain/card-issuer.port';
import { CardProductApplicationMode } from '../domain/card-product-application-mode.enum';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { CardProviderIntentRejectedError } from '../domain/card-provider-intent-rejected.error';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardType } from '../domain/card-type.enum';
import { FundingNetwork } from '../domain/funding-network.enum';
import { ResolvedCardProduct } from './card-product-resolver';
import { QuoteCardFundingUseCase } from './quote-card-funding.usecase';

describe('QuoteCardFundingUseCase', () => {
  let useCase: QuoteCardFundingUseCase;
  let resolveByPublicId: jest.Mock;
  let quoteCardFunding: jest.Mock;
  let capabilities: Set<CardCapability>;
  let warn: jest.SpyInstance;

  const product = (
    overrides: Partial<ResolvedCardProduct> = {},
  ): ResolvedCardProduct => ({
    id: '77',
    publicId: 'product-1',
    providerKey: CardProviderKey.HYPERCARD,
    providerProductId: '52400002',
    applicationMode: CardProductApplicationMode.NO_KYC,
    cardType: CardType.VIRTUAL,
    currencyCode: 'USD',
    requiresInitialDeposit: true,
    depositMinInitial: '10',
    issuanceFee: { amount: '20', currencyCode: 'USDT' },
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

    resolveByPublicId = jest.fn().mockResolvedValue(product());
    quoteCardFunding = jest.fn().mockResolvedValue(quoteResult());
    capabilities = new Set([CardCapability.FUNDING_QUOTE]);

    useCase = new QuoteCardFundingUseCase(
      { resolveByPublicId } as never,
      {
        resolve: jest.fn(() => ({ capabilities, quoteCardFunding })),
      } as never,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  const execute = (
    overrides: Partial<Parameters<QuoteCardFundingUseCase['execute']>[0]> = {},
  ) =>
    useCase.execute({
      cardProductPublicId: 'product-1',
      initialDepositAmount: '100',
      ...overrides,
    });

  it('asks the issuer for the product and the fiat amount', async () => {
    await execute();

    expect(quoteCardFunding).toHaveBeenCalledWith(
      '52400002',
      { depositAmount: '100', currencyCode: 'USD' },
      {},
    );
  });

  it('adds the catalogue fee to the deposit cost', async () => {
    const quote = await execute();

    expect(quote.depositCost).toEqual({
      amount: '102.71614508',
      currencyCode: 'USDT',
    });
    expect(quote.issuanceFee).toEqual({ amount: '20', currencyCode: 'USDT' });
    expect(quote.total).toEqual({
      amount: '122.71614508',
      currencyCode: 'USDT',
    });
  });

  it('rounds the payable figure up to what the chain can carry', async () => {
    const quote = await execute({ network: FundingNetwork.TRON });

    expect(quote.payable).toEqual({
      amount: '122.716146',
      currencyCode: 'USDT',
      network: FundingNetwork.TRON,
      decimals: 6,
    });
  });

  it('answers the coarsest precision when no chain is named', async () => {
    const quote = await execute();

    expect(quote.payable).toEqual({
      amount: '122.716146',
      currencyCode: 'USDT',
      network: null,
      decimals: 6,
    });
  });

  it('keeps the extra places when the named chain carries them', async () => {
    const quote = await execute({ network: FundingNetwork.BSC });

    expect(quote.payable).toEqual({
      amount: '122.71614508',
      currencyCode: 'USDT',
      network: FundingNetwork.BSC,
      decimals: 18,
    });
  });

  it('publishes the components and no total when the fee is in another currency', async () => {
    resolveByPublicId.mockResolvedValue(
      product({ issuanceFee: { amount: '20', currencyCode: 'USD' } }),
    );

    const quote = await execute();

    expect(quote.total).toBeNull();
    expect(quote.payable).toBeNull();
    expect(quote.depositCost.amount).toBe('102.71614508');
    expect(quote.issuanceFee).toEqual({ amount: '20', currencyCode: 'USD' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'billed in USD where the deposit is paid in USDT',
      ),
    );
  });

  it('totals the cost alone when the issuer charges no card fee', async () => {
    resolveByPublicId.mockResolvedValue(product({ issuanceFee: null }));

    const quote = await execute();

    expect(quote.issuanceFee).toBeNull();
    expect(quote.total).toEqual({
      amount: '102.71614508',
      currencyCode: 'USDT',
    });
  });

  it('publishes no payable figure for a coin no supported chain holds', async () => {
    quoteCardFunding.mockResolvedValue(
      quoteResult({
        cost: { amount: '1', currencyCode: 'BTC' },
        fee: { amount: '0', currencyCode: 'BTC' },
      }),
    );
    resolveByPublicId.mockResolvedValue(product({ issuanceFee: null }));

    const quote = await execute();

    expect(quote.total).toEqual({ amount: '1', currencyCode: 'BTC' });
    expect(quote.payable).toBeNull();
  });

  it("refuses a deposit below the product's own minimum, before calling", async () => {
    await expect(
      execute({ initialDepositAmount: '9.99999999' }),
    ).rejects.toThrow(BadRequestException);
    expect(quoteCardFunding).not.toHaveBeenCalled();
  });

  it('accepts a deposit exactly at the minimum', async () => {
    await expect(
      execute({ initialDepositAmount: '10.00' }),
    ).resolves.toBeDefined();
  });

  it('quotes any amount when the product states no minimum', async () => {
    resolveByPublicId.mockResolvedValue(
      product({ depositMinInitial: null, requiresInitialDeposit: false }),
    );

    await expect(execute({ initialDepositAmount: '1' })).resolves.toBeDefined();
  });

  it('refuses rather than pricing against a minimum it cannot read', async () => {
    resolveByPublicId.mockResolvedValue(product({ depositMinInitial: 'n/a' }));

    await expect(execute()).rejects.toThrow(BadRequestException);
    expect(quoteCardFunding).not.toHaveBeenCalled();
  });

  it('refuses an issuer that does not declare the capability, before calling', async () => {
    capabilities.clear();

    await expect(execute()).rejects.toThrow(ForbiddenException);
    expect(quoteCardFunding).not.toHaveBeenCalled();
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
    await expect(execute()).rejects.toBeInstanceOf(ConflictException);
  });

  it("answers a refused value with the adapter's own composed sentence", async () => {
    quoteCardFunding.mockRejectedValue(
      new CardProviderIntentRejectedError(
        CardProviderKey.HYPERCARD,
        'initialDepositAmount',
        'the issuer would not price this deposit',
      ),
    );

    await expect(execute()).rejects.toBeInstanceOf(BadRequestException);
  });

  it('warns when the issuer priced a different deposit from the one asked about', async () => {
    quoteCardFunding.mockResolvedValue(
      quoteResult({ credited: { amount: '95', currencyCode: 'USD' } }),
    );

    const quote = await execute();

    expect(quote.credited.amount).toBe('95');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('against a requested opening deposit of 100'),
    );
  });

  it('does not warn about a credit written to a different number of places', async () => {
    // '100.00000000' is the '100' that was asked for; a textual compare would
    // report every quote as a mismatch.
    await execute();

    expect(warn).not.toHaveBeenCalled();
  });

  it('does not hand back one object as both the total and the deposit cost', async () => {
    resolveByPublicId.mockResolvedValue(product({ issuanceFee: null }));

    const quote = await execute();

    expect(quote.total).toEqual(quote.depositCost);
    expect(quote.total).not.toBe(quote.depositCost);
  });

  it('lets an unrecognised provider failure through unchanged', async () => {
    const failure = new Error('connection reset');
    quoteCardFunding.mockRejectedValue(failure);

    await expect(execute()).rejects.toBe(failure);
  });
});
