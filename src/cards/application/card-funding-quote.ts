import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { CardFundingQuoteIntent } from '../domain/card-funding-quote-intent.model';
import {
  CardFundingAmount,
  CardFundingQuoteResult,
  CardIssuerPort,
} from '../domain/card-issuer.port';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { CardProviderIntentRejectedError } from '../domain/card-provider-intent-rejected.error';
import { FundingNetwork } from '../domain/funding-network.enum';
import { fundingCoinPrecision } from '../domain/funding-token';
import {
  compareDecimalStrings,
  roundUpDecimalString,
} from './decimal-amount.util';

const logger = new Logger('CardFundingQuote');

/** The figure to send, rounded to what its chain can carry. */
export interface CardFundingPayable extends CardFundingAmount {
  /** Null when no chain was named — payable on every supported one. */
  network: FundingNetwork | null;
  decimals: number;
}

/** An owed amount rounded **up** to what its chain carries — down underfunds the card. */
export const payableFundingAmount = (
  owed: CardFundingAmount,
  network: FundingNetwork | null,
): CardFundingPayable | null => {
  const decimals = fundingCoinPrecision(owed.currencyCode, network);
  if (decimals === null) {
    logger.warn(
      `No supported chain holds ${owed.currencyCode}${network ? ` on ${network}` : ''} — publishing the quote without a payable figure`,
    );
    return null;
  }

  const amount = roundUpDecimalString(owed.amount, decimals);
  if (amount === null) {
    logger.warn(
      `Could not round "${owed.amount}" to ${decimals} places — publishing the quote without a payable figure`,
    );
    return null;
  }

  return { amount, currencyCode: owed.currencyCode, network, decimals };
};

/**
 * Prices an amount, translating a refusal into a partner-facing error.
 * `amountField` is the **caller's own** request field: the adapter names the one
 * it knows, and this method is reached from more than one route.
 */
export const requestFundingQuote = async (
  issuer: CardIssuerPort,
  providerProductId: string,
  intent: CardFundingQuoteIntent,
  amountField: string,
): Promise<CardFundingQuoteResult> => {
  try {
    return await issuer.quoteCardFunding(providerProductId, intent, {});
  } catch (error) {
    // Never their wire text in a body; it survives on `cause` for the log.
    if (error instanceof CardProviderConflictError) {
      throw new ConflictException(
        'The card provider will not price a deposit for this product — it may not accept deposits at all',
        { cause: error },
      );
    }

    if (error instanceof CardProviderIntentRejectedError) {
      throw new BadRequestException(error.namedFor(amountField).message, {
        cause: error,
      });
    }

    throw error;
  }
};

/** Published rather than refused: an issuer may legitimately round what it credits. */
export const warnOnQuotedCreditMismatch = (
  requested: string,
  credited: CardFundingAmount,
  subject: string,
  requestedLabel: string,
): void => {
  // By value, not by text: they publish eight places where a partner sends none.
  if (compareDecimalStrings(credited.amount, requested) === 0) return;

  logger.warn(
    `${subject} was priced for a credit of ${credited.amount} ${credited.currencyCode} against a requested ${requestedLabel} of ${requested} — the quoted cost buys the issuer's figure, not the requested one`,
  );
};
