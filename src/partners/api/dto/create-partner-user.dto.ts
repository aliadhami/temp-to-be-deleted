import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class CreatePartnerUserDto {
  @ApiProperty({ example: 'ops@partnercompany.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 12 })
  @IsString()
  @MinLength(12)
  password!: string;

  @ApiProperty({ example: 'Partner Ops' })
  @IsString()
  @MinLength(2)
  displayName!: string;
}
