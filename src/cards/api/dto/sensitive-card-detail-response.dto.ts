import { ApiProperty } from '@nestjs/swagger';

/**
 * The partner-facing shapes of a card's sensitive detail — one class per arm
 * of the domain's `RevealedCardDetail` union. These exist to be published, not
 * to be constructed.
 */

const MASKED_PAN = { example: '624673******6680' } as const;
const PAN = {
  example: '6246731234566680',
  description:
    'The full card number. Never stored by this system — treat it as PCI-scoped in yours',
} as const;

/** Everything needed to use the card online. */
export class SensitiveCardDetailFullResponseDto {
  @ApiProperty({ enum: ['FULL'] })
  kind!: 'FULL';

  @ApiProperty(MASKED_PAN)
  maskedPan!: string;

  /**
   * Optional because an issuer can hold the security code and expiry while
   * returning only a masked number. Absent means the issuer does not return
   * the full number, never that the card has none.
   */
  @ApiProperty({ ...PAN, required: false })
  pan?: string;

  @ApiProperty({ example: '123', description: 'Security code (CVV/CVC)' })
  cvv!: string;

  @ApiProperty({ example: 4, minimum: 1, maximum: 12 })
  expiryMonth!: number;

  @ApiProperty({ example: 2025 })
  expiryYear!: number;
}

/**
 * The number alone, because the issuer does not return this card's secrets
 * through the API at all. A complete answer, not a partial one.
 */
export class SensitiveCardDetailNumberOnlyResponseDto {
  @ApiProperty({ enum: ['NUMBER_ONLY'] })
  kind!: 'NUMBER_ONLY';

  @ApiProperty(MASKED_PAN)
  maskedPan!: string;

  @ApiProperty(PAN)
  pan!: string;
}

/**
 * No card data at all — a page the cardholder opens themselves. The URL is
 * handed over as the issuer gave it; nothing here proxies, renders or stores
 * what is behind it.
 */
export class SensitiveCardDetailHostedPageResponseDto {
  @ApiProperty({ enum: ['HOSTED_PAGE'] })
  kind!: 'HOSTED_PAGE';

  @ApiProperty({ example: 'https://issuer.example/card/8888888888888888' })
  url!: string;

  @ApiProperty({
    required: false,
    example: '888888',
    description: 'Entered on the page above, when the issuer sets one',
  })
  password?: string;

  @ApiProperty({
    required: false,
    format: 'date-time',
    description:
      'When the page stops working. Absent when the issuer publishes no expiry',
  })
  expiresAt?: string;
}

/**
 * The number, with the security code and expiry delivered to the cardholder by
 * the issuer rather than returned here.
 */
export class SensitiveCardDetailCardholderDirectResponseDto {
  @ApiProperty({ enum: ['CARDHOLDER_DIRECT'] })
  kind!: 'CARDHOLDER_DIRECT';

  @ApiProperty(MASKED_PAN)
  maskedPan!: string;

  @ApiProperty(PAN)
  pan!: string;
}
