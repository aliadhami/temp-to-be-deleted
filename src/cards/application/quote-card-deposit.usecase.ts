import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CardCapability } from '../domain/card-capability.enum';
import { CardFundingAmount } from '../domain/card-issuer.port';
import { FundingNetwork } from '../domain/funding-network.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { assertCardCapability } from './assert-card-capability';
import { assertDepositAmountWithinLimits } from './card-deposit-limits';
import {
  CardFundingPayable,
  payableFundingAmount,
  requestFundingQuote,
  warnOnQuotedCreditMismatch,
} from './card-funding-quote';
import { CardProductResolver } from './card-product-resolver';

export interface QuoteCardDepositInput {
  partnerId: string;
  cardPublicId: string;
  amount: string;
  network?: FundingNetwork | null;
}

/**
 * What one top-up costs in the coin it is paid with. **No card fee and no
 * total** — the card is open already, and a fee here overcharges a partner by
 * the price of a card.
 */
export interface CardDepositQuote {
  cardPublicId: string;
  credited: CardFundingAmount;
  depositCost: CardFundingAmount;
  /** Already inside `depositCost` — never added to it. */
  depositFee: CardFundingAmount;
  payable: CardFundingPayable | null;
  quotedAt: string;
}

/**
 * What a partner must send to put more money on a card it already holds.
 *
 * **Not gated on the card's status**, unlike the deposit itself: the price
 * depends on the product and the amount, never on the card.
 */
@Injectable()
export class QuoteCardDepositUseCase {
  constructor(
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    private readonly cardProductResolver: CardProductResolver,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
  ) {}

  async execute(input: QuoteCardDepositInput): Promise<CardDepositQuote> {
    const card = await this.cardRepository.findOne({
      where: { publicId: input.cardPublicId, partnerId: input.partnerId },
      select: { id: true, publicId: true, providerKey: true },
    });
    // 404 rather than 403: the scoping is in the query, so "not yours" and
    // "does not exist" are indistinguishable.
    if (!card) {
      throw new NotFoundException('Card not found');
    }

    const issuer = this.cardIssuerRegistry.resolve(card.providerKey);
    assertCardCapability(
      issuer,
      CardCapability.FUNDING_QUOTE,
      card.providerKey,
      'quoting what topping up a card costs',
    );

    const product = await this.cardProductResolver.resolveForCard(
      card.id,
      card.providerKey,
    );
    if (!product) {
      throw new ConflictException(
        `Card ${card.publicId} has no card product recorded — there is nothing to price a top-up against`,
      );
    }

    // The same gate the deposit applies: a quote a partner acts on must not
    // become a deposit refused once the money is sent.
    assertDepositAmountWithinLimits(input.amount, product);

    const quote = await requestFundingQuote(
      issuer,
      product.providerProductId,
      { depositAmount: input.amount, currencyCode: product.currencyCode },
      'amount',
    );
    warnOnQuotedCreditMismatch(
      input.amount,
      quote.credited,
      `Card ${card.publicId}`,
      'top-up',
    );

    return {
      cardPublicId: card.publicId,
      credited: quote.credited,
      depositCost: quote.cost,
      depositFee: quote.fee,
      payable: payableFundingAmount(quote.cost, input.network ?? null),
      quotedAt: quote.quotedAt,
    };
  }
}
