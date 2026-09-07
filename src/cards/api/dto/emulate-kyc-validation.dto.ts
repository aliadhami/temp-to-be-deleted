import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsIn } from 'class-validator';
import { CardProviderKey } from '../../domain/card-provider-key.enum';

export class EmulateKycValidationDto {
  @ApiProperty({ enum: CardProviderKey })
  @IsEnum(CardProviderKey)
  providerKey!: CardProviderKey;

  @ApiProperty({ enum: ['pass', 'fail'] })
  @IsIn(['pass', 'fail'])
  result!: 'pass' | 'fail';
}
