import { ApiProperty } from '@nestjs/swagger';
import { PaymentStatus } from '../../domain/payment-status.enum';

export class PaymentInitiationResponseDto {
  @ApiProperty() publicId!: string;
  @ApiProperty({ enum: PaymentStatus }) status!: PaymentStatus;
  @ApiProperty({ enum: ['REDIRECT', 'FORM_POST'] }) redirectKind!:
    'REDIRECT' | 'FORM_POST';
  @ApiProperty() redirectUrl!: string;
  @ApiProperty({ required: false, type: Object }) params?: Record<
    string,
    string
  >;
}

export class PaymentDetailResponseDto {
  @ApiProperty() publicId!: string;
  @ApiProperty() gatewayKey!: string;
  @ApiProperty() method!: string;
  @ApiProperty() amount!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: PaymentStatus }) status!: PaymentStatus;
  @ApiProperty() referenceNumber!: string;
  @ApiProperty({ required: false, nullable: true }) checkoutReturnUrl!:
    string | null;
  @ApiProperty() createdAt!: Date;
}
