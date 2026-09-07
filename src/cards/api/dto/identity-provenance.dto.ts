import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Length, Matches } from 'class-validator';

export class IdentityProvenanceDto {
  @ApiProperty({ example: 'American' })
  @IsString()
  @Length(2, 50)
  nationality!: string;
  @ApiProperty({ example: 'USA' }) @Matches(/^[A-Z]{3}$/) placeOfBirth!: string;
  @ApiProperty({ enum: [0, 1, 2] }) @IsIn([0, 1, 2]) gender!: 0 | 1 | 2;
  /**
   * Four digits, not three. The three-digit form silently excluded every
   * Caribbean dialling code — 1246 Barbados, 1876 Jamaica, 1268 Antigua and
   * eighteen others — which are ordinary country codes, not an issuer's quirk.
   */
  @ApiProperty({ example: '1', description: 'Digits only, no leading +' })
  @Matches(/^\d{1,4}$/)
  callingCode!: string;
  @ApiProperty({ example: 'US' })
  @Matches(/^[A-Z]{2}$/)
  countryCallingCode!: string;
  @ApiProperty({ example: '4155551234' }) @IsString() cellNumber!: string;
}
