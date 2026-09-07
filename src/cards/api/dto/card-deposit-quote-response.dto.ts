import { ApiProperty } from '@nestjs/swagger';
import {
  CardFundingAmountResponseDto,
  CardFundingPayableResponseDto,
} from './card-funding-quote-response.dto';

/** What it costs to put more money on a card that already exists. */
export class CardDepositQuoteResponseDto {
  @ApiProperty({ description: 'The card this quote tops up' })
  cardPublicId!: string;

  @ApiProperty({
    type: CardFundingAmountResponseDto,
    description:
      'What lands on the card, in the card’s own currency. This is the provider’s own figure — check it against the top-up you asked for, because the cost below buys this amount rather than the requested one',
  })
  credited!: CardFundingAmountResponseDto;

  @ApiProperty({
    type: CardFundingAmountResponseDto,
    description:
      'What the top-up costs in the coin it is paid with, including the provider’s exchange fee below',
  })
  depositCost!: CardFundingAmountResponseDto;

  @ApiProperty({
    type: CardFundingAmountResponseDto,
    description:
      'The provider’s charge on the exchange. Already included in the deposit cost — do not add it again',
  })
  depositFee!: CardFundingAmountResponseDto;

  @ApiProperty({
    type: CardFundingPayableResponseDto,
    nullable: true,
    description:
      'The amount to send. Null when no supported chain holds the coin this was priced in',
  })
  payable!: CardFundingPayableResponseDto | null;

  @ApiProperty({
    example: '2026-02-03T04:05:06.789Z',
    description:
      'When the provider was asked. They publish no timestamp and no validity window, so this is the moment of the call',
  })
  quotedAt!: string;
}
