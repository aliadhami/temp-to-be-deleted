import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { GatewayKey } from '../../domain/gateway-key.enum';
import { PaymentMethod } from '../../domain/payment-method.enum';

export class InitiatePaymentDto {
  @ApiProperty({
    description:
      'Idempotency key you generate — unique per gateway. Retrying with the same value returns 409, not a duplicate charge.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  requestId!: string;

  @ApiProperty({
    description: 'Your own reference number for this transaction',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  referenceNumber!: string;

  @ApiProperty({ enum: GatewayKey })
  @IsEnum(GatewayKey)
  gatewayKey!: GatewayKey;

  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @ApiProperty({
    example: '10.00',
    description:
      'Decimal string, up to 20 integer digits and 18 decimal places. Send it as a string, never a JSON number — a float cannot represent crypto amounts exactly. Fractional part optional: "10", "10.00" and "0.00000001" are all valid.',
  })
  @Matches(/^\d{1,20}(\.\d{1,18})?$/, {
    message:
      'amount must be a positive decimal string with at most 20 integer digits and 18 decimal places — e.g. 10.00 or 0.00000001',
  })
  amount!: string;

  @ApiProperty({
    example: 'AED',
    description:
      'Fiat ISO 4217 code (AED, USD) or a crypto asset code (USDT). Uppercase letters, digits and underscore, 3–20 chars.',
  })
  @Matches(/^[A-Z0-9_]{3,20}$/, {
    message:
      'currency must be 3–20 uppercase characters (A–Z, 0–9, _) — e.g. AED or USDT',
  })
  currency!: string;

  @ApiProperty({
    required: false,
    example: 'TRON',
    description:
      'Blockchain network, required by crypto gateways. Omit to use the gateway default (PAYMENTS_<GATEWAY>_DEFAULT_CHAIN). Ignored by fiat gateways. CASE-SENSITIVE — pass the provider spelling exactly. SunPay accepts: TRON, Ethereum, BNBSmartChain, Aptos, Solana, PolygonPOS, ArbitrumOne.',
  })
  @IsOptional()
  // Mixed case is REQUIRED, not merely tolerated: SunPay's chain identifiers are
  // case-sensitive ("Ethereum" is valid, "ETHEREUM" and "ethereum" both return
  // "not found currency"). Never normalise this value's case anywhere.
  @Matches(/^[A-Za-z0-9]{2,30}$/, {
    message:
      'chainType must be 2–30 letters/digits, matching the provider spelling exactly (case-sensitive) — e.g. TRON, Ethereum, BNBSmartChain',
  })
  chainType?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsEmail()
  customerEmail?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  customerName?: string;

  @ApiProperty({ required: false, example: 'AE' })
  @IsOptional()
  @Matches(/^[A-Z]{2}$/, {
    message: 'customerCountry must be a 2-letter ISO 3166-1 alpha-2 code',
  })
  customerCountry?: string;
}
