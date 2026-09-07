import { ApiProperty } from '@nestjs/swagger';
import { CardProviderKey } from '../../domain/card-provider-key.enum';
import { CardholderStatus } from '../../domain/cardholder-status.enum';

/** One issuer's standing with this person. */
export class CardholderEnrolmentResponseDto {
  @ApiProperty({ enum: CardProviderKey })
  providerKey!: CardProviderKey;

  @ApiProperty({ enum: CardholderStatus })
  status!: CardholderStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The issuer’s own code for a decision, when it published one',
  })
  reasonCode!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'What the issuer said about the decision, in its own words',
  })
  message!: string | null;

  @ApiProperty()
  createdAt!: Date;
}

/**
 * The partner-facing shape of one cardholder. It carries no issuer's own
 * identifier for the person, and none of the identity material the partner
 * supplied at onboarding.
 */
export class CardholderResponseDto {
  @ApiProperty({ format: 'uuid' })
  publicId!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;

  @ApiProperty()
  email!: string;

  /**
   * One entry per issuer this person has been put to. A person approved by one
   * issuer is not thereby approved by another, so there is no single status
   * here to read.
   */
  @ApiProperty({
    type: [CardholderEnrolmentResponseDto],
    description:
      'This person’s standing with each issuer they have been enrolled with',
  })
  enrolments!: CardholderEnrolmentResponseDto[];

  @ApiProperty()
  createdAt!: Date;
}

export class CardholderListResponseDto {
  @ApiProperty({ type: [CardholderResponseDto] })
  items!: CardholderResponseDto[];

  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
}
