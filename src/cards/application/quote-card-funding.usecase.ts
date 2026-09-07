import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { CardCapability } from '../domain/card-capability.enum';
import { CardFundingAmount } from '../domain/card-issuer.port';
import { FundingNetwork } from '../domain/funding-network.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { assertCardCapability } from './assert-card-capability';
import {
  CardFundingPayable,
  payableFundingAmount,
  requestFundingQuote,
  warnOnQuotedCreditMismatch,
} from './card-funding-quote';
import {
  CardProductResolver,
  ResolvedCardProduct,
} from './card-product-resolver';
import {
  addDecimalStrings,
  compareDecimalStrings,
} from './decimal-amount.util';

export interface QuoteCardFundingInput {
  cardProductPublicId: string;
  initialDepositAmount: string;
  network?: FundingNetwork | null;
}

export interface CardFundingQuote {
  cardProductPublicId: string;
  credited: CardFundingAmount;
  depositCost: CardFundingAmount;
  /** Already inside `depositCost` — never added to it. */
  depositFee: CardFundingAmount;
  issuanceFee: CardFundingAmount | null;
  /** Null when the components are not in one currency. */
  total: CardFundingAmount | null;
  payable: CardFundingPayable | null;
  quotedAt: string;
}

/**
 * What a partner must send to open one card: the issuer's price for the opening
 * deposit plus the card fee, added in the coin rather than in the card's
 * currency.
 */
@Injectable()
export class QuoteCardFundingUseCase {
  private readonly logger = new Logger(QuoteCardFundingUseCase.name);

  constructor(
    private readonly cardProductResolver: CardProductResolver,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
  ) {}

  async execute(input: QuoteCardFundingInput): Promise<CardFundingQuote> {
    const product = await this.cardProductResolver.resolveByPublicId(
      input.cardProductPublicId,
    );

    const issuer = this.cardIssuerRegistry.resolve(product.providerKey);
    // Above the outbound call, so an issuer with no price to give is refused
    // rather than reaching a method it has not got.
    assertCardCapability(
      issuer,
      CardCapability.FUNDING_QUOTE,
      product.providerKey,
      'quoting what opening a card costs',
    );

    // The same gate issuance applies, so a quote a partner acts on cannot
    // become an application that is refused after the money is sent.
    this.assertMeetsMinimum(input.initialDepositAmount, product);

    const quote = await requestFundingQuote(
      issuer,
      product.providerProductId,
      {
        depositAmount: input.initialDepositAmount,
        currencyCode: product.currencyCode,
      },
      'initialDepositAmount',
    );
    warnOnQuotedCreditMismatch(
      input.initialDepositAmount,
      quote.credited,
      `Card product ${product.publicId}`,
      'opening deposit',
    );

    const issuanceFee = product.issuanceFee;
    const total = this.total(quote.cost, issuanceFee);

    return {
      cardProductPublicId: product.publicId,
      credited: quote.credited,
      depositCost: quote.cost,
      depositFee: quote.fee,
      issuanceFee,
      total,
      payable: total
        ? payableFundingAmount(total, input.network ?? null)
        : null,
      quotedAt: quote.quotedAt,
    };
  }

  /** Refuses an opening deposit below the product's own mandated minimum. */
  private assertMeetsMinimum(
    amount: string,
    product: ResolvedCardProduct,
  ): void {
    const minimum = product.depositMinInitial;
    if (minimum === null) return;

    const comparison = compareDecimalStrings(amount, minimum);
    if (comparison === null) {
      this.logger.error(
        `Card product ${product.publicId} has an unreadable minimum opening deposit "${minimum}" — refusing to quote rather than pricing an unchecked amount`,
      );
      throw new BadRequestException(
        'This card product has a minimum opening deposit this service cannot read — contact support',
      );
    }

    if (comparison < 0) {
      throw new BadRequestException(
        `This card product opens with at least ${minimum} ${product.currencyCode} — requested ${amount}`,
      );
    }
  }

  /**
   * The deposit's cost plus the card fee. **Null rather than a sum when the two
   * are not in one currency** — adding across currencies is the failure that
   * would look right.
   */
  private total(
    cost: CardFundingAmount,
    issuanceFee: CardFundingAmount | null,
  ): CardFundingAmount | null {
    // A copy: `total` and `depositCost` must not be one object.
    if (issuanceFee === null) return { ...cost };

    if (
      issuanceFee.currencyCode.toUpperCase() !== cost.currencyCode.toUpperCase()
    ) {
      this.logger.warn(
        `Card fee is billed in ${issuanceFee.currencyCode} where the deposit is paid in ${cost.currencyCode} — publishing the components without a total`,
      );
      return null;
    }

    const amount = addDecimalStrings(cost.amount, issuanceFee.amount);
    if (amount === null) {
      this.logger.warn(
        `Could not add a card fee of "${issuanceFee.amount}" to a deposit cost of "${cost.amount}" — publishing the components without a total`,
      );
      return null;
    }

    return { amount, currencyCode: cost.currencyCode };
  }
}
