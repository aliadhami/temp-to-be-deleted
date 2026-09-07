import { ApiProperty } from '@nestjs/swagger';
import { CardDepositStatus } from '../../domain/card-deposit-status.enum';

/**
 * The partner-facing shape of one deposit. It carries no issuer vocabulary at
 * all — not the issuer's own identifier for the deposit, not the reference we
 * send them, not the coin our account with them is debited in, and not their
 * card id.
 */
export class CardDepositResponseDto {
  @ApiProperty({ format: 'uuid' })
  publicId!: string;

  @ApiProperty({ description: 'The idempotency key you supplied' })
  requestId!: string;

  @ApiProperty({
    example: '25.00',
    description: 'What you asked to put on the card. Decimal string.',
  })
  amount!: string;

  @ApiProperty({ example: 'USD', description: "The card's own currency" })
  currency!: string;

  @ApiProperty({ enum: CardDepositStatus })
  status!: CardDepositStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'What the provider says actually landed, once it has settled. Null until then — and not necessarily equal to the amount requested, since a provider’s own fee and exchange rate apply.',
  })
  creditedAmount!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why this deposit did not succeed. Null while it is progressing normally.',
  })
  reason!: string | null;

  @ApiProperty()
  createdAt!: Date;
}

export class CardDepositListResponseDto {
  @ApiProperty({ type: [CardDepositResponseDto] })
  items!: CardDepositResponseDto[];

  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
}
