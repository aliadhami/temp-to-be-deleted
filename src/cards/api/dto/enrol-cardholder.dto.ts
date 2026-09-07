import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { CardProviderKey } from '../../domain/card-provider-key.enum';

export class EnrolCardholderDto {
  @ApiProperty({
    enum: CardProviderKey,
    description: 'The issuer to put this cardholder to',
  })
  @IsEnum(CardProviderKey)
  providerKey!: CardProviderKey;
}
