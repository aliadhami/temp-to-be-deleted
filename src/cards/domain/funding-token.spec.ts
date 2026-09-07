import { FundingNetwork } from './funding-network.enum';
import { FUNDING_TOKENS, fundingCoinPrecision } from './funding-token';

describe('FUNDING_TOKENS', () => {
  /** An overstated exponent quotes an amount the chain cannot carry. */
  it.each([
    [FundingNetwork.ETHEREUM, 6],
    [FundingNetwork.BSC, 18],
    [FundingNetwork.POLYGON, 6],
    [FundingNetwork.OPTIMISM, 6],
    [FundingNetwork.ARBITRUM, 6],
    [FundingNetwork.TRON, 6],
  ])('holds the payable coin on %s at %i places', (network, decimals) => {
    expect(FUNDING_TOKENS[network]).toEqual({ coin: 'USDT', decimals });
  });

  it('cannot be rewritten at runtime, entries included', () => {
    const bsc = FUNDING_TOKENS[FundingNetwork.BSC];

    expect(Object.isFrozen(FUNDING_TOKENS)).toBe(true);
    expect(Object.isFrozen(bsc)).toBe(true);
    expect(() => {
      (bsc as { decimals: number }).decimals = 0;
    }).toThrow(TypeError);
    expect(FUNDING_TOKENS[FundingNetwork.BSC].decimals).toBe(18);
  });

  it('covers every supported network', () => {
    expect(Object.keys(FUNDING_TOKENS).sort()).toEqual(
      Object.values(FundingNetwork).sort(),
    );
  });
});

describe('fundingCoinPrecision', () => {
  it("answers the named chain's own precision", () => {
    expect(fundingCoinPrecision('USDT', FundingNetwork.BSC)).toBe(18);
    expect(fundingCoinPrecision('USDT', FundingNetwork.TRON)).toBe(6);
  });

  it('answers the coarsest precision when no chain is named', () => {
    expect(fundingCoinPrecision('USDT', null)).toBe(6);
  });

  it('matches a coin whatever case it arrives in', () => {
    expect(fundingCoinPrecision('usdt', null)).toBe(6);
    expect(fundingCoinPrecision('usdt', FundingNetwork.BSC)).toBe(18);
  });

  it('answers nothing for a coin no supported chain holds', () => {
    expect(fundingCoinPrecision('BTC', null)).toBeNull();
    expect(fundingCoinPrecision('BTC', FundingNetwork.ETHEREUM)).toBeNull();
  });
});
