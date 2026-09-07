import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import { POSITIVE_DECIMAL_PATTERN } from './amount-patterns';
import { FundingNetworkQueryDto } from './funding-network-query.dto';

export class CardFundingQuoteQueryDto extends FundingNetworkQueryDto {
  @ApiProperty({
    example: '100',
    description:
      'The opening deposit to price, as a decimal string in the product’s own currency. At most 8 decimal places.',
  })
  @Matches(POSITIVE_DECIMAL_PATTERN, {
    message:
      'initialDepositAmount must be a decimal string greater than zero, with at most 8 decimal places',
  })
  initialDepositAmount!: string;
}
