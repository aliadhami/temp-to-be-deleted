import { CurrencyOrCoinCode } from './card-product.model';
import { FundingNetwork } from './funding-network.enum';

/**
 * What one token is on one chain. **Never read from a chain response** — every
 * field describing a token comes from its contract, so all of them belong to
 * whoever deployed it.
 */
export interface FundingToken {
  /** Not ISO 4217 — `USDT` is four characters. */
  readonly coin: CurrencyOrCoinCode;
  /** Places an amount can carry on this chain, and so the precision to round to. */
  readonly decimals: number;
}

/** The payable token on each supported chain. */
export const FUNDING_TOKENS: Readonly<Record<FundingNetwork, FundingToken>> =
  Object.freeze({
    // Each entry frozen as well as the map: `Object.freeze` is shallow, so
    // without these every exponent stays writable.
    [FundingNetwork.ETHEREUM]: Object.freeze({ coin: 'USDT', decimals: 6 }),
    [FundingNetwork.BSC]: Object.freeze({ coin: 'USDT', decimals: 18 }),
    [FundingNetwork.POLYGON]: Object.freeze({ coin: 'USDT', decimals: 6 }),
    [FundingNetwork.OPTIMISM]: Object.freeze({ coin: 'USDT', decimals: 6 }),
    [FundingNetwork.ARBITRUM]: Object.freeze({ coin: 'USDT', decimals: 6 }),
    [FundingNetwork.TRON]: Object.freeze({ coin: 'USDT', decimals: 6 }),
  });

/**
 * Places an amount of `coin` can carry — on `network`, or the coarsest across
 * every chain holding it when none is named. **Null is not a licence to pick a
 * default**: an overstated precision quotes an amount the chain cannot carry.
 */
export const fundingCoinPrecision = (
  coin: CurrencyOrCoinCode,
  network: FundingNetwork | null,
): number | null => {
  const wanted = coin.toUpperCase();

  if (network !== null) {
    const token = FUNDING_TOKENS[network];
    return token.coin.toUpperCase() === wanted ? token.decimals : null;
  }

  const decimals = Object.values(FUNDING_TOKENS)
    .filter((token) => token.coin.toUpperCase() === wanted)
    .map((token) => token.decimals);

  return decimals.length === 0 ? null : Math.min(...decimals);
};
