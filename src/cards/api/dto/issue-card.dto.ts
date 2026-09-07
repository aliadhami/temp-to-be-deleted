import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { NAME_ON_CARD_MAX_LENGTH } from '../../domain/card-issuance-intent.model';
import {
  CURRENCY_CODE_PATTERN,
  POSITIVE_DECIMAL_PATTERN,
} from './amount-patterns';
import { CardProviderKey } from '../../domain/card-provider-key.enum';
import { CardType } from '../../domain/card-type.enum';

export class IssueCardDto {
  /**
   * Which issuer opens this card. A cardholder can be enrolled with several
   * and approved by only some, so the request names one rather than the
   * cardholder implying it.
   */
  @ApiProperty({
    enum: CardProviderKey,
    description:
      'The issuer to open the card with. The cardholder must hold an approved enrolment with it.',
  })
  @IsEnum(CardProviderKey)
  providerKey!: CardProviderKey;

  @ApiProperty({ enum: CardType }) @IsEnum(CardType) cardType!: CardType;

  /**
   * The name to print on the card. Required only for an issuer that lets the
   * caller choose it, which is what `CardCapability.CUSTOM_NAME_ON_CARD` says.
   */
  @ApiProperty({
    required: false,
    description:
      'Name to print on the card. Required for issuers that accept one; must be omitted for issuers that name the card after the cardholder.',
  })
  @IsOptional()
  @IsString()
  // Bounded to the column it lands in. Without this a long name passes
  // validation and fails at the insert instead, which under this server's
  // strict mode is a 500 for a field the partner controls — and the derived
  // path is already trimmed to the same limit, so the two would disagree.
  @MaxLength(NAME_ON_CARD_MAX_LENGTH)
  nameOnCard?: string | null;

  /**
   * The card's currency. Required only when the issuer publishes no product
   * catalogue.
   */
  @ApiProperty({
    required: false,
    example: 'USD',
    description:
      "The card's fiat currency as a three-letter ISO code. Required only for issuers with no product catalogue; otherwise taken from the product.",
  })
  @IsOptional()
  @Matches(CURRENCY_CODE_PATTERN)
  currency?: string | null;

  /**
   * Which catalogue product to open, by the `public_id` from `GET
   * /cards/products`. Optional on the DTO and required at the use-case layer
   * for a provider that publishes a catalogue — a provider with no product
   * concept has nothing to resolve.
   */
  @ApiProperty({
    required: false,
    format: 'uuid',
    description:
      'Card product public id, from GET /cards/products. Required for providers that publish a catalogue.',
  })
  @IsOptional()
  @IsUUID()
  cardProductPublicId?: string | null;

  /**
   * The opening deposit to commit with this application, in the product's own
   * currency. Required at the use-case layer when the resolved product
   * mandates one, and refused below its stated minimum.
   */
  @ApiProperty({
    required: false,
    example: '10',
    description:
      "Opening deposit in the product's currency, as a decimal string. Required when the resolved product mandates one.",
  })
  @IsOptional()
  @Matches(POSITIVE_DECIMAL_PATTERN, {
    message:
      'initialDepositAmount must be a decimal string greater than zero, with at most 8 decimal places',
  })
  initialDepositAmount?: string | null;
}
