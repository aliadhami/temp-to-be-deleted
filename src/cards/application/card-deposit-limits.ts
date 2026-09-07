import { BadRequestException, Logger } from '@nestjs/common';
import { CardDepositProduct } from './card-product-resolver';
import { compareDecimalStrings } from './decimal-amount.util';

const logger = new Logger('CardDepositLimits');

/** An unreadable stored bound. Never partner input — the request patterns refuse it. */
const unreadableLimit = (which: string, value: string): BadRequestException => {
  logger.error(
    `Card product has an unreadable per-transaction deposit ${which} "${value}" — refusing rather than acting on an unchecked amount`,
  );

  return new BadRequestException(
    `This card's product has a deposit ${which} this service cannot read — contact support`,
  );
};

/**
 * Refuses an amount outside the product's per-transaction bounds. **No daily
 * cap** — that one is the issuer's, on their timezone. **A null product passes
 * rather than refuses**; whether that is acceptable is the caller's to decide.
 */
export const assertDepositAmountWithinLimits = (
  amount: string,
  product: CardDepositProduct | null,
): void => {
  if (!product) return;

  const { depositMinPerTransaction, depositMaxPerTransaction, currencyCode } =
    product;

  if (depositMinPerTransaction !== null) {
    const comparison = compareDecimalStrings(amount, depositMinPerTransaction);
    if (comparison === null) {
      throw unreadableLimit('minimum', depositMinPerTransaction);
    }
    if (comparison < 0) {
      throw new BadRequestException(
        `This card's product takes deposits of at least ${depositMinPerTransaction} ${currencyCode} — amount is ${amount}`,
      );
    }
  }

  if (depositMaxPerTransaction !== null) {
    const comparison = compareDecimalStrings(amount, depositMaxPerTransaction);
    if (comparison === null) {
      throw unreadableLimit('maximum', depositMaxPerTransaction);
    }
    if (comparison > 0) {
      throw new BadRequestException(
        `This card's product takes deposits of at most ${depositMaxPerTransaction} ${currencyCode} — amount is ${amount}`,
      );
    }
  }
};
