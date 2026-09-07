import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsNumberString,
  IsOptional,
  IsString,
  IsUrl,
  MinLength,
} from 'class-validator';
import { PartnerStatus } from '../../domain/partner-status.enum';

export class UpdatePartnerDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiProperty({ required: false, enum: PartnerStatus })
  @IsOptional()
  @IsEnum(PartnerStatus)
  status?: PartnerStatus;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  allowedGateways?: string[];

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  allowedCurrencies?: string[];

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  allowedMethods?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumberString()
  feePercent?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumberString()
  feeFlat?: string;

  @ApiProperty({
    required: false,
    example: 'https://pay-dashboard.partner.com/checkout/return',
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  checkoutReturnUrl?: string;
}
