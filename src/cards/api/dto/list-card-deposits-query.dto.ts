import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { CardDepositStatus } from '../../domain/card-deposit-status.enum';

/**
 * Paged exactly as `GET /cards` is, rather than with a second pagination idiom
 * on one controller: a partner who has learned one of this API's list
 * responses has learned all of them.
 */
export class ListCardDepositsQueryDto {
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

  /**
   * The only filter, and it is the one worth having: a partner reconciling is
   * looking for the deposits that did not settle.
   */
  @ApiProperty({ required: false, enum: CardDepositStatus })
  @IsOptional()
  @IsEnum(CardDepositStatus)
  status?: CardDepositStatus;
}
