import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HyperCardMockService } from '../infrastructure/providers/hypercard/hypercard-mock.service';
import { MockHyperCardMerchantBalanceUseCase } from './mock-hypercard-merchant-balance.usecase';

describe('MockHyperCardMerchantBalanceUseCase', () => {
  let useCase: MockHyperCardMerchantBalanceUseCase;
  let mockService: { mockAddBalance: jest.Mock };

  /** A live top-up row: eight decimal places, and a string throughout. */
  const usdt = { coin: 'usdt', balance: '100000.00000000' };

  beforeEach(async () => {
    mockService = { mockAddBalance: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MockHyperCardMerchantBalanceUseCase,
        { provide: HyperCardMockService, useValue: mockService },
      ],
    }).compile();

    useCase = module.get(MockHyperCardMerchantBalanceUseCase);
    jest.clearAllMocks();
  });

  it('stops at one call when that call credited', async () => {
    mockService.mockAddBalance.mockResolvedValueOnce({
      credited: true,
      balances: [usdt],
    });

    const result = await useCase.execute();

    expect(mockService.mockAddBalance).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      credited: true,
      attempts: 1,
      balances: [usdt],
    });
  });

  it('calls again when the first call credited nothing', async () => {
    mockService.mockAddBalance
      .mockResolvedValueOnce({ credited: false, balances: [] })
      .mockResolvedValueOnce({ credited: true, balances: [usdt] });

    const result = await useCase.execute();

    expect(mockService.mockAddBalance).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      credited: true,
      attempts: 2,
      balances: [usdt],
    });
  });

  // A third call would credit a float that two calls already moved.
  it('stops at two calls and reports that nothing was credited', async () => {
    mockService.mockAddBalance.mockResolvedValue({
      credited: false,
      balances: [],
    });

    const result = await useCase.execute();

    expect(mockService.mockAddBalance).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ credited: false, attempts: 2, balances: [] });
  });

  it('calls again when they returned rows that are all zero', async () => {
    mockService.mockAddBalance
      .mockResolvedValueOnce({
        credited: true,
        balances: [{ coin: 'usdt', balance: '0.00000000' }],
      })
      .mockResolvedValueOnce({ credited: true, balances: [usdt] });

    const result = await useCase.execute();

    expect(mockService.mockAddBalance).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ credited: true, attempts: 2, balances: [usdt] });
  });

  it('credits on any coin holding something, not only the first', async () => {
    mockService.mockAddBalance.mockResolvedValueOnce({
      credited: true,
      balances: [{ coin: 'usdt', balance: '0.00000000' }, usdt],
    });

    const result = await useCase.execute();

    expect(mockService.mockAddBalance).toHaveBeenCalledTimes(1);
    expect(result.credited).toBe(true);
  });

  it('treats an unparseable amount as nothing', async () => {
    mockService.mockAddBalance.mockResolvedValue({
      credited: true,
      balances: [{ coin: 'usdt', balance: 'not a number' }],
    });

    const result = await useCase.execute();

    expect(mockService.mockAddBalance).toHaveBeenCalledTimes(2);
    expect(result.credited).toBe(false);
  });

  it('does not retry past a refusal', async () => {
    mockService.mockAddBalance.mockRejectedValueOnce(
      new ForbiddenException(
        'HyperCard mock endpoints exist only in their sandbox',
      ),
    );

    await expect(useCase.execute()).rejects.toThrow(ForbiddenException);
    expect(mockService.mockAddBalance).toHaveBeenCalledTimes(1);
  });

  it('re-throws anything else unchanged', async () => {
    mockService.mockAddBalance.mockRejectedValueOnce(
      new Error('the issuer is unreachable'),
    );

    await expect(useCase.execute()).rejects.toThrow(
      'the issuer is unreachable',
    );
    expect(mockService.mockAddBalance).toHaveBeenCalledTimes(1);
  });
});
