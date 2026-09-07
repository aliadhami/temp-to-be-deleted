import { ApiProperty } from '@nestjs/swagger';
import { FundingNetwork } from '../../domain/funding-network.enum';

/** An amount and what it is denominated in. */
export class CardFundingAmountResponseDto {
  @ApiProperty({
    example: '102.71614508',
    description: 'Decimal string, never a number',
  })
  amount!: string;

  @ApiProperty({
    example: 'USDT',
    description:
      'A currency or coin ticker, upper-cased. Not always three characters — a coin is not an ISO 4217 currency',
  })
  currencyCode!: string;
}

/** The figure that can actually be sent on a chain. */
export class CardFundingPayableResponseDto {
  @ApiProperty({
    example: '102.716146',
    description:
      'The total rounded **up** to what the chain can carry. Send this figure, not the total: a chain holds the coin to a fixed number of decimal places, and a wallet asked for more truncates — which underpays',
  })
  amount!: string;

  @ApiProperty({ example: 'USDT' })
  currencyCode!: string;

  @ApiProperty({
    // Nullable, never absent: the null means payable on every supported chain.
    nullable: true,
    enum: FundingNetwork,
    description:
      'The chain this figure was rounded for. Null when you named none, in which case it is payable on every supported chain',
  })
  network!: FundingNetwork | null;

  @ApiProperty({
    example: 6,
    description: 'Decimal places the amount was rounded up to',
  })
  decimals!: number;
}

/** What it costs to open one card of one product with one opening deposit. */
export class CardFundingQuoteResponseDto {
  @ApiProperty({ description: 'The product this quote prices' })
  cardProductPublicId!: string;

  @ApiProperty({
    type: CardFundingAmountResponseDto,
    description:
      'What lands on the card, in the card’s own currency. This is the provider’s own figure — check it against the deposit you asked for, because the cost below buys this amount rather than the requested one',
  })
  credited!: CardFundingAmountResponseDto;

  @ApiProperty({
    type: CardFundingAmountResponseDto,
    description:
      'What the opening deposit costs in the coin it is paid with, including the provider’s exchange fee below',
  })
  depositCost!: CardFundingAmountResponseDto;

  @ApiProperty({
    type: CardFundingAmountResponseDto,
    description:
      'The provider’s charge on the exchange. Already included in the deposit cost — do not add it again',
  })
  depositFee!: CardFundingAmountResponseDto;

  @ApiProperty({
    type: CardFundingAmountResponseDto,
    nullable: true,
    description:
      'The one-off fee to open the card. Null when the provider charges none',
  })
  issuanceFee!: CardFundingAmountResponseDto | null;

  @ApiProperty({
    type: CardFundingAmountResponseDto,
    nullable: true,
    description:
      'Everything owed. Null when the card fee and the deposit are not billed in the same currency — the components are published either way, and adding across two currencies is not something this will do for you',
  })
  total!: CardFundingAmountResponseDto | null;

  @ApiProperty({
    type: CardFundingPayableResponseDto,
    nullable: true,
    description: 'The amount to send. Null whenever there is no total',
  })
  payable!: CardFundingPayableResponseDto | null;

  @ApiProperty({
    example: '2026-02-03T04:05:06.789Z',
    description:
      'When the provider was asked. They publish no timestamp and no validity window, so this is the moment of the call',
  })
  quotedAt!: string;
}
