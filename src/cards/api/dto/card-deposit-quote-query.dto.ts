import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import { POSITIVE_DECIMAL_PATTERN } from './amount-patterns';
import { FundingNetworkQueryDto } from './funding-network-query.dto';

export class CardDepositQuoteQueryDto extends FundingNetworkQueryDto {
  @ApiProperty({
    example: '100',
    description:
      'The top-up to price, as a decimal string in the currency this card’s product is denominated in. At most 8 decimal places.',
  })
  @Matches(POSITIVE_DECIMAL_PATTERN, {
    message:
      'amount must be a decimal string greater than zero, with at most 8 decimal places',
  })
  amount!: string;
}
