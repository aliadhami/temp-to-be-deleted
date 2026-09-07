import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsNumberString,
  IsOptional,
  IsString,
  IsUrl,
  MinLength,
} from 'class-validator';

export class CreatePartnerDto {
  @ApiProperty({ example: 'Acme Exchange LLC' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ example: ['MLT', 'SUNPAY'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  allowedGateways!: string[];

  @ApiProperty({ example: ['AED', 'USD'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  allowedCurrencies!: string[];

  @ApiProperty({ example: ['FIAT_CARD', 'CRYPTO'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  allowedMethods!: string[];

  @ApiProperty({ required: false, example: '2.500' })
  @IsOptional()
  @IsNumberString()
  feePercent?: string;

  @ApiProperty({ required: false, example: '1.50' })
  @IsOptional()
  @IsNumberString()
  feeFlat?: string;

  @ApiProperty({
    required: false,
    example: 'https://pay-dashboard.partner.com/checkout/return',
    description:
      "Where the customer's browser is redirected after checkout completes (browser-redirect gateways only)",
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  checkoutReturnUrl?: string;
}
