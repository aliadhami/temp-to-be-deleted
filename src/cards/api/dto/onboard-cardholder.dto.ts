import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsIP,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { CardProviderKey } from '../../domain/card-provider-key.enum';
import { IdentityProvenanceDto } from './identity-provenance.dto';
import { ResidentialAddressDto } from './residential-address.dto';

export class OnboardCardholderDto {
  @ApiProperty({ enum: CardProviderKey })
  @IsEnum(CardProviderKey)
  providerKey!: CardProviderKey;
  @ApiProperty() @IsString() firstName!: string;
  @ApiProperty() @IsString() lastName!: string;
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty({ example: '+14155551234' })
  @Matches(/^\+\d{6,19}$/)
  phone!: string;
  @ApiProperty({ example: '1990-05-14' }) @IsDateString() dateOfBirth!: string;

  @ApiProperty({ type: ResidentialAddressDto })
  @ValidateNested()
  @Type(() => ResidentialAddressDto)
  residentialAddress!: ResidentialAddressDto;

  @ApiProperty({ type: IdentityProvenanceDto })
  @ValidateNested()
  @Type(() => IdentityProvenanceDto)
  identityProvenance!: IdentityProvenanceDto;

  /**
   * The end user's own IP address, as the partner observed it when the person
   * asked for a card. The partner has to send it; it cannot be taken from the
   * request.
   */
  @ApiProperty({
    required: false,
    example: '203.0.113.42',
    description: "The end user's IP, as seen by the partner — not the caller's",
  })
  @IsOptional()
  @IsIP()
  userIp?: string;
}
