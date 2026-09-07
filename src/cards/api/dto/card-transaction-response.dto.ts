import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * One row of a card's statement, as a partner sees it. The statement belongs
 * to the issuer and is read live, not stored — so this is a projection of what
 * they answered rather than of a row of ours.
 */
export class CardTransactionResponseDto {
  @ApiProperty({
    description: "The issuer's own identifier for this transaction",
    example: '202608182138436344937976',
  })
  id!: string;

  @ApiProperty({
    example: '-14.99',
    description:
      'Signed decimal string in the currency below. Negative took money off the card, positive put money on it. Unsigned where the issuer did not say which.',
  })
  amount!: string;

  @ApiProperty({
    example: 'USD',
    description:
      "The currency this row is denominated in — usually the card's own, though an issuer may state a card-cancellation refund in the coin it was returned in.",
  })
  currencyCode!: string;

  @ApiProperty({
    example: 'settled',
    description:
      'What the issuer says became of it. Vocabularies differ by issuer; a value that is not final should be read again later.',
  })
  status!: string;

  @ApiProperty({
    example: 'recharge',
    description:
      'What kind of transaction it is. `unknown` where the issuer used a code we do not model — the row is still listed, because it still happened.',
  })
  category!: string;

  @ApiPropertyOptional({
    example: 'MONTHLY FEE',
    description:
      "The issuer's own label for the row, where it publishes one. Absent rather than empty when it does not.",
  })
  description?: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The merchant, for a purchase, where the issuer publishes one. Null otherwise.',
  })
  merchantName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '12.50',
    description:
      'What the merchant charged in their own currency, for a foreign purchase. Decimal string. Null where the issuer publishes none.',
  })
  merchantAmount!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'EUR',
    description: 'The currency of the amount above. Null where there is none.',
  })
  merchantCurrency!: string | null;

  @ApiProperty({
    description: 'When the transaction happened, ISO 8601 UTC',
  })
  createdAt!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'When it reached the card statement, ISO 8601 UTC. Null where the issuer publishes no such date.',
  })
  settledAt!: string | null;
}

export class CardTransactionListResponseDto {
  @ApiProperty({ format: 'uuid' })
  cardPublicId!: string;

  @ApiProperty({ type: [CardTransactionResponseDto] })
  items!: CardTransactionResponseDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Pass back as `cursor` for the next page. Null when there is none. Opaque — its contents are the provider integration’s and may change without notice.',
  })
  nextCursor!: string | null;
}
