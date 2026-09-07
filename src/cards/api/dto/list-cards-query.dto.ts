import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { CardProviderKey } from '../../domain/card-provider-key.enum';
import { CardStatus } from '../../domain/card-status.enum';

export class ListCardsQueryDto {
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

  @ApiProperty({ required: false, enum: CardStatus })
  @IsOptional()
  @IsEnum(CardStatus)
  status?: CardStatus;

  @ApiProperty({
    required: false,
    description: 'Filter to cards belonging to one cardholder',
  })
  @IsOptional()
  @IsUUID()
  cardholderPublicId?: string;

  /**
   * Filters the stored rows and nothing else. A card stays listable after its
   * issuer is switched off in this deployment — a read must not depend on
   * which providers are currently enabled.
   */
  @ApiProperty({
    required: false,
    enum: CardProviderKey,
    description: 'Filter to cards held at one issuer',
  })
  @IsOptional()
  @IsEnum(CardProviderKey)
  providerKey?: CardProviderKey;
}
