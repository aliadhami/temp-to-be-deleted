import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import {
  HYPERCARD_MOCK_CONSUME_TRANSACTION_TYPES,
  HYPERCARD_MOCK_TRANSACTION_STATUSES,
} from '../../infrastructure/providers/hypercard/hypercard-mock.service';
import {
  NON_NEGATIVE_DECIMAL_PATTERN,
  POSITIVE_DECIMAL_PATTERN,
} from './amount-patterns';

const UNIX_SECONDS = /^\d{1,11}$/;

/**
 * Drives HyperCard's transaction-consume mock. **Deliberate exception to "never
 * import an adapter's types from outside that adapter's folder"**: restating
 * their type and status lists here is how the two drift, and this DTO is one
 * issuer's sandbox surface rather than a shared one.
 */
export class MockHyperCardConsumeDto {
  @ApiProperty({
    example: '10.00',
    description:
      'Amount in the transaction currency, as a positive decimal string of up to eight places.',
  })
  @IsString()
  @Matches(POSITIVE_DECIMAL_PATTERN, {
    message: 'amount must be a positive decimal string',
  })
  amount!: string;

  @ApiPropertyOptional({
    example: '10.00',
    description:
      'The same transaction in USD. Defaults to amount, which is right only for a USD card — their mock carries no currency field.',
  })
  @IsOptional()
  @IsString()
  @Matches(POSITIVE_DECIMAL_PATTERN, {
    message: 'amountUsd must be a positive decimal string',
  })
  amountUsd?: string;

  @ApiPropertyOptional({
    example: 'admin emulation',
    description:
      'Free text stored against the transaction. Their statement returns it for ever, so make it obviously synthetic.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  description?: string;

  @ApiPropertyOptional({
    example: '0.00',
    description:
      'Applicable for certain card types. A decimal string, zero or greater.',
  })
  @IsOptional()
  @IsString()
  // Zero is a real fee, so not the positive pattern.
  @Matches(NON_NEGATIVE_DECIMAL_PATTERN, {
    message: 'fee must be a decimal string, zero or greater',
  })
  fee?: string;

  @ApiPropertyOptional({
    example: '1595497477',
    description:
      'Unix timestamp in seconds. Defaults to now; set it to reach an earlier statement month.',
  })
  @IsOptional()
  @IsString()
  @Matches(UNIX_SECONDS, {
    message: 'transactionDate must be a Unix timestamp in seconds',
  })
  transactionDate?: string;

  @ApiPropertyOptional({
    enum: [...HYPERCARD_MOCK_CONSUME_TRANSACTION_TYPES],
    description:
      'Their transaction-type code. Defaults to consume. Recharge, purchase crypto coin and cancel card are refused here.',
  })
  @IsOptional()
  @IsIn(HYPERCARD_MOCK_CONSUME_TRANSACTION_TYPES)
  type?: number;

  @ApiPropertyOptional({
    enum: [...HYPERCARD_MOCK_TRANSACTION_STATUSES],
    description: '1 success, 2 failed. Defaults to success.',
  })
  @IsOptional()
  @IsIn(HYPERCARD_MOCK_TRANSACTION_STATUSES)
  status?: number;
}
