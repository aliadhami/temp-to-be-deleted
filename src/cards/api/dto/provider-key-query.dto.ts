import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { CardProviderKey } from '../../domain/card-provider-key.enum';

/** For a read that names an issuer and has no body to carry it. */
export class ProviderKeyQueryDto {
  @ApiProperty({ enum: CardProviderKey })
  @IsEnum(CardProviderKey)
  providerKey!: CardProviderKey;
}
