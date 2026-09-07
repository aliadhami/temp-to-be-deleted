import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListTransactionsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ description: 'Unix epoch seconds' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  before?: number;

  @ApiPropertyOptional({ description: 'Unix epoch seconds' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  after?: number;

  @ApiPropertyOptional({
    description: "Continuation token from a previous response's next_cursor",
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}
