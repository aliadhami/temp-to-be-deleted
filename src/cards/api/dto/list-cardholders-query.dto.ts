import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { CardProviderKey } from '../../domain/card-provider-key.enum';
import { CardholderStatus } from '../../domain/cardholder-status.enum';

export class ListCardholdersQueryDto {
  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiProperty({ required: false, enum: CardholderStatus })
  @IsOptional()
  @IsEnum(CardholderStatus)
  status?: CardholderStatus;

  /**
   * Filters the stored rows and nothing else. A cardholder stays listable
   * after the issuer they were onboarded with is switched off in this
   * deployment — a read must not depend on which providers are currently
   * enabled.
   */
  @ApiProperty({
    required: false,
    enum: CardProviderKey,
    description: 'Filter to cardholders onboarded with one issuer',
  })
  @IsOptional()
  @IsEnum(CardProviderKey)
  providerKey?: CardProviderKey;
}
