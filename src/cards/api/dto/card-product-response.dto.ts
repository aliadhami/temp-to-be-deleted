import { ApiProperty } from '@nestjs/swagger';
import { CardLifecycleOperation } from '../../domain/card-lifecycle-operation.enum';
import { CardMaterial } from '../../domain/card-material.enum';
import { CardOrganisation } from '../../domain/card-organisation.enum';
import { CardProductActivationMode } from '../../domain/card-product-activation-mode.enum';
import { CardProductApplicationMode } from '../../domain/card-product-application-mode.enum';
import { CardProductSensitiveDetailMode } from '../../domain/card-product-sensitive-detail-mode.enum';
import { CardProviderKey } from '../../domain/card-provider-key.enum';
import { CardType } from '../../domain/card-type.enum';

/**
 * The partner-facing shape of a card product. It carries a provider's product
 * meaning and none of its vocabulary: no issuer product handle, no issuer
 * codes, no raw response.
 */
export class CardProductFeeResponseDto {
  @ApiProperty({
    example: '20',
    description: 'Decimal string, never a number',
  })
  amount!: string;

  /**
   * Each fee carries its own currency because an issuer does not necessarily
   * bill every fee in the card's own currency — a card denominated in USD may
   * be opened for a price in a stablecoin.
   */
  @ApiProperty({
    example: 'USDT',
    description: 'Need not be the card’s own currency',
  })
  currencyCode!: string;
}

export class CardProductFeesResponseDto {
  @ApiProperty({
    type: CardProductFeeResponseDto,
    nullable: true,
    description:
      'One-off fee to open a card. Null when the issuer charges none',
  })
  issuance!: CardProductFeeResponseDto | null;

  @ApiProperty({
    type: CardProductFeeResponseDto,
    nullable: true,
    description:
      'Recurring fee to keep a card open. Null when the issuer charges none',
  })
  annual!: CardProductFeeResponseDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '1.5',
    description:
      'Fee taken on each deposit, in percent units — "1.5" means 1.5%. Null when depositing is free',
  })
  depositFeePercent!: string | null;
}

export class CardProductDepositLimitsResponseDto {
  @ApiProperty({ type: String, nullable: true, example: '10' })
  minPerTransaction!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '100000' })
  maxPerTransaction!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '1000000' })
  maxPerDay!: string | null;

  /**
   * Separate from the amount below because the two are independent facts: an
   * issuer can mandate an opening deposit while stating no minimum for it.
   */
  @ApiProperty({
    description:
      'Whether a card requires an opening deposit before it is usable',
  })
  requiresInitialDeposit!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '10',
    description:
      'The mandated minimum opening deposit, when the issuer states one',
  })
  minInitialDeposit!: string | null;
}

export class CardProductActivationResponseDto {
  @ApiProperty({ enum: CardProductActivationMode })
  mode!: CardProductActivationMode;

  /**
   * Meaningful only on `ISSUER_REQUEST`. Null on `CARDHOLDER_DIRECT`, where
   * there is no activation call to attach a document to — not `false`, which
   * would read as "a call that needs no document".
   */
  @ApiProperty({
    type: Boolean,
    nullable: true,
    description:
      'Whether activating the card requires an identity document. Null when the mode has no activation call',
  })
  requiresIdentityDocument!: boolean | null;
}

export class CardProductResponseDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Quote this when issuing a card against the product',
  })
  publicId!: string;

  @ApiProperty({ example: 'Mastercard Virtual USD' })
  displayName!: string;

  @ApiProperty({ enum: CardType })
  cardType!: CardType;

  @ApiProperty({ enum: CardOrganisation })
  cardOrganisation!: CardOrganisation;

  @ApiProperty({
    enum: CardMaterial,
    nullable: true,
    description:
      'Null when the issuer publishes no material — read cardType to learn whether a card is physical',
  })
  material!: CardMaterial | null;

  @ApiProperty({
    example: 'USD',
    description:
      'The currency the card itself is denominated in. Not always ISO 4217 — a crypto-funded program may denominate in a coin ticker',
  })
  currencyCode!: string;

  @ApiProperty({ type: CardProductFeesResponseDto })
  fees!: CardProductFeesResponseDto;

  @ApiProperty({ type: CardProductDepositLimitsResponseDto })
  depositLimits!: CardProductDepositLimitsResponseDto;

  @ApiProperty({
    enum: CardProductApplicationMode,
    description: 'What a cardholder has to supply to be issued one of these',
  })
  applicationMode!: CardProductApplicationMode;

  @ApiProperty({
    description:
      'Whether a cardholder has to supply identity documents to be issued one of these',
  })
  requiresKyc!: boolean;

  @ApiProperty({ type: CardProductActivationResponseDto })
  activation!: CardProductActivationResponseDto;

  /**
   * What reading one of these cards gives you. Null when the issuer publishes
   * nothing we can place, which does not stop the product being issued.
   */
  @ApiProperty({
    enum: CardProductSensitiveDetailMode,
    nullable: true,
    description:
      'How a card issued against this product yields its number, security code and expiry. API returns them directly; HOSTED_PAGE returns a link the cardholder opens; CARDHOLDER_DIRECT returns the number only, with the secrets sent to the cardholder by the issuer. Null when the issuer publishes no readable value',
  })
  sensitiveDetailMode!: CardProductSensitiveDetailMode | null;

  @ApiProperty({
    description:
      'False means the provider will refuse a new application for this product',
  })
  availableForIssuance!: boolean;

  @ApiProperty({
    enum: CardLifecycleOperation,
    isArray: true,
    example: [CardLifecycleOperation.BLOCK, CardLifecycleOperation.UNBLOCK],
    description:
      'Which operations the issuer offers against a card issued against this product, once it exists. Empty means it offers none of them — not that the product cannot be issued, funded or read. BLOCK, UNBLOCK and CHANGE_PIN have endpoints on this API today; the rest are published because the issuer offers them and are not yet callable here',
  })
  supportedOperations!: readonly CardLifecycleOperation[];
}

export class CardProductListResponseDto {
  @ApiProperty({ enum: CardProviderKey })
  providerKey!: CardProviderKey;

  /**
   * When this snapshot was last confirmed against the provider — on the
   * envelope rather than per product, because one refresh stamps every row
   * with one timestamp, and because this is the only place that can still
   * answer "how old is this?" when the catalogue comes back empty.
   */
  @ApiProperty({
    type: Date,
    nullable: true,
    description: 'When this snapshot was last confirmed against the provider',
  })
  syncedAt!: Date | null;

  @ApiProperty({ type: [CardProductResponseDto] })
  items!: CardProductResponseDto[];
}
