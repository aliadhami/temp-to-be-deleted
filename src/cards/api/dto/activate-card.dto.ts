import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** The longest activation document this API accepts, in base64 characters. */
export const MAX_ACTIVATION_DOCUMENT_LENGTH = 2_000_000;

/**
 * Raw base64: the alphabet and its padding, and nothing else. Line breaks are
 * excluded too, so an encoder that wraps at 76 characters is refused here
 * rather than by the issuer.
 */
const RAW_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export class ActivateCardDto {
  /**
   * The four printed values and the chosen PIN, for an issuer that activates a
   * card the cardholder is physically holding. Optional here and required at
   * the use-case layer.
   */
  @ApiProperty({
    required: false,
    description:
      'Printed card number. Required for issuers that activate a card in the cardholder’s hand.',
  })
  @IsOptional()
  @Matches(/^\d{12,19}$/)
  pan?: string | null;

  @ApiProperty({ required: false, minimum: 1, maximum: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  expiryMonth?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  expiryYear?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @Matches(/^\d{3,4}$/)
  cvv?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @Matches(/^\d{4}$/)
  pin?: string | null;

  /**
   * A photograph of the cardholder holding their identity document and the
   * card, base64-encoded — for an issuer whose activation is an identity
   * check.
   */
  @ApiProperty({
    required: false,
    description:
      'Base64-encoded photo of the cardholder with their identity document and the card. Raw base64 — no "data:" URI prefix. Required for issuers that activate by identity check.',
  })
  @IsOptional()
  @MaxLength(MAX_ACTIVATION_DOCUMENT_LENGTH)
  @Matches(RAW_BASE64_PATTERN, {
    message:
      'activationDocument must be raw base64 — remove any "data:image/...;base64," prefix and any line breaks',
  })
  activationDocument?: string | null;
}
