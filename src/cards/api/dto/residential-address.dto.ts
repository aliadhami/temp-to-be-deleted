import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

export class ResidentialAddressDto {
  @ApiProperty() @IsString() addressLine1!: string;
  @ApiProperty() @IsString() city!: string;
  @ApiProperty({ example: 'US' }) @Matches(/^[A-Z]{2}$/) country!: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() state?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() zipCode?: string;
}
