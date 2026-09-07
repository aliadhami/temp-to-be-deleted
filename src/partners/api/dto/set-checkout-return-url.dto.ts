import { ApiProperty } from '@nestjs/swagger';
import { IsUrl } from 'class-validator';

export class SetCheckoutReturnUrlDto {
  @ApiProperty({ example: 'https://pay-dashboard.partner.com/checkout/return' })
  @IsUrl({ require_tld: false })
  checkoutReturnUrl!: string;
}
