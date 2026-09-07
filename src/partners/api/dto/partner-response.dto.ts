import { ApiProperty } from '@nestjs/swagger';
import { PartnerStatus } from '../../domain/partner-status.enum';

export class PartnerResponseDto {
  @ApiProperty() publicId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: PartnerStatus }) status!: PartnerStatus;
  @ApiProperty({ type: [String] }) allowedGateways!: string[];
  @ApiProperty({ type: [String] }) allowedCurrencies!: string[];
  @ApiProperty({ type: [String] }) allowedMethods!: string[];
  @ApiProperty({ required: false, nullable: true }) feePercent!: string | null;
  @ApiProperty({ required: false, nullable: true }) feeFlat!: string | null;
  @ApiProperty({ required: false, nullable: true }) webhookUrl!: string | null;
  @ApiProperty({ required: false, nullable: true }) checkoutReturnUrl!:
    string | null;
  @ApiProperty() createdAt!: Date;
}
