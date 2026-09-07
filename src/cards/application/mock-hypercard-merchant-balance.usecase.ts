import { Injectable } from '@nestjs/common';
import {
  HyperCardMockCoinBalance,
  HyperCardMockService,
} from '../infrastructure/providers/hypercard/hypercard-mock.service';
import { compareDecimalStrings } from './decimal-amount.util';

/** Their "invoke this api again" instruction. Calling again regardless credits twice. */
const MAX_ATTEMPTS = 2;

/**
 * Read from the amounts, never from rows being present: their first call
 * creates the coin records at zero. A null comparison is unparseable, so zero.
 */
const holdsSomething = (balances: HyperCardMockCoinBalance[]): boolean =>
  balances.some((balance) => {
    const comparison = compareDecimalStrings(balance.balance, '0');
    return comparison !== null && comparison > 0;
  });

export interface MockHyperCardMerchantBalanceResult {
  credited: boolean;
  attempts: number;
  balances: HyperCardMockCoinBalance[];
}

/**
 * Tops up the merchant float — our own operational position, not a card's and
 * not a partner's.
 */
@Injectable()
export class MockHyperCardMerchantBalanceUseCase {
  constructor(private readonly mockService: HyperCardMockService) {}

  async execute(): Promise<MockHyperCardMerchantBalanceResult> {
    let attempts = 0;
    let credited = false;
    let balances: HyperCardMockCoinBalance[] = [];

    while (attempts < MAX_ATTEMPTS && !credited) {
      attempts += 1;
      const result = await this.mockService.mockAddBalance();
      balances = result.balances;
      credited = holdsSomething(balances);
    }

    return { credited, attempts, balances };
  }
}
