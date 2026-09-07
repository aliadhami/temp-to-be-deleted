import {
  MerchantBalanceEntry,
  MerchantBalanceResult,
} from '../../../domain/card-issuer.port';
import {
  normaliseHyperCardText,
  readHyperCardAmount,
} from './hypercard-coercion.util';
import { HyperCardMerchantBalanceEntry } from './hypercard.types';

/** Their "Merchant Balance" answer could not be turned into a float. */
export class HyperCardMerchantBalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HyperCardMerchantBalanceError';
  }
}

const readAmount = (raw: unknown, field: string, coin: string): string =>
  readHyperCardAmount(
    raw,
    (value) =>
      new HyperCardMerchantBalanceError(
        `HyperCard returned ${field} "${String(
          value,
        )}" for coin "${coin}" on a merchant balance inquiry, which is not an amount this can read`,
      ),
  );

/**
 * Their merchant balance rows, as the port's float result. **Every unreadable
 * shape throws** — the opposite of the catalogue read, which degrades to an
 * empty snapshot.
 */
export const mapHyperCardMerchantBalance = (
  data: unknown,
  observedAt: Date,
): MerchantBalanceResult => {
  // The one empty answer that is real: an account holding no coin record.
  if (data === null || data === undefined) {
    return { entries: [], observedAt: observedAt.toISOString() };
  }

  if (!Array.isArray(data)) {
    throw new HyperCardMerchantBalanceError(
      `HyperCard answered a merchant balance inquiry with a ${typeof data} where their page documents a list of coin balances`,
    );
  }

  const rows = data as readonly HyperCardMerchantBalanceEntry[];
  const seenCoins = new Set<string>();

  const entries: MerchantBalanceEntry[] = rows.map((row) => {
    const coin = normaliseHyperCardText(row?.coin);
    if (coin === null) {
      throw new HyperCardMerchantBalanceError(
        `HyperCard returned coin "${String(
          row?.coin,
        )}" on a merchant balance inquiry, which names no asset`,
      );
    }

    const currencyCode = coin.toUpperCase();
    if (seenCoins.has(currencyCode)) {
      throw new HyperCardMerchantBalanceError(
        `HyperCard returned more than one balance for coin "${coin}" on a merchant balance inquiry`,
      );
    }
    seenCoins.add(currencyCode);

    return {
      currencyCode,
      available: readAmount(row?.amount, 'amount', coin),
      ledger: readAmount(row?.total_amount, 'total_amount', coin),
    };
  });

  return { entries, observedAt: observedAt.toISOString() };
};
