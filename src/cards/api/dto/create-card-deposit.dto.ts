import { ApiProperty } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { CARD_DEPOSIT_REQUEST_ID_MAX_LENGTH } from '../../domain/card-deposit-intent.model';
import {
  CURRENCY_CODE_PATTERN,
  POSITIVE_DECIMAL_PATTERN,
} from './amount-patterns';

/** Their documented cap on the note attached to a deposit. */
const REMARK_MAX_LENGTH = 255;

export class CreateCardDepositDto {
  /** The partner's own idempotency key for this deposit. */
  @ApiProperty({
    maxLength: CARD_DEPOSIT_REQUEST_ID_MAX_LENGTH,
    description:
      'Your own idempotency key for this deposit. Replaying it returns 409 naming the existing deposit.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(CARD_DEPOSIT_REQUEST_ID_MAX_LENGTH)
  requestId!: string;

  /**
   * How much to put on the card, in the card's own currency. Checked against
   * the product's per-transaction limits before anything is called; the daily
   * cap is the issuer's to apply, on their timezone.
   */
  @ApiProperty({
    example: '25.00',
    description:
      "Amount to deposit, as a decimal string in the card's currency. At most 8 decimal places.",
  })
  @Matches(POSITIVE_DECIMAL_PATTERN, {
    message:
      'amount must be a decimal string greater than zero, with at most 8 decimal places',
  })
  amount!: string;

  /**
   * The card's currency. Optional because a deposit has no currency of its
   * own.
   */
  @ApiProperty({
    required: false,
    example: 'USD',
    description:
      "The card's currency as a three-letter ISO code. Optional; taken from the card when omitted, and refused when it disagrees.",
  })
  @IsOptional()
  @Matches(CURRENCY_CODE_PATTERN)
  currency?: string | null;

  /**
   * A note carried to the issuer with the deposit. Forwarded rather than
   * stored — it belongs to the issuer's own record, where a partner reads it
   * back.
   */
  @ApiProperty({
    required: false,
    maxLength: REMARK_MAX_LENGTH,
    description: 'Free-text note passed to the card provider with the deposit.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(REMARK_MAX_LENGTH)
  remark?: string | null;
}
