import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { CardProviderKey } from '../../domain/card-provider-key.enum';

export class SubmitKycDto {
  @ApiProperty({
    enum: CardProviderKey,
    description:
      'Which issuer’s KYC step to submit — the cardholder must be enrolled with it',
  })
  @IsEnum(CardProviderKey)
  providerKey!: CardProviderKey;
}
