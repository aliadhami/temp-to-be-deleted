import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, ValidateIf } from 'class-validator';

const BLOCK_REASONS = [
  'lost',
  'stolen',
  'customer_request',
  'fraud_review',
  'compliance',
  'other',
] as const;

export class UpdateCardStatusDto {
  @ApiProperty({ enum: ['active', 'on_hold'] })
  @IsIn(['active', 'on_hold'])
  status!: 'active' | 'on_hold';

  @ApiProperty({ enum: BLOCK_REASONS, required: false })
  @ValidateIf((dto: UpdateCardStatusDto) => dto.status === 'on_hold')
  @IsIn(BLOCK_REASONS, {
    message: 'reason is required when status is "on_hold"',
  })
  @IsOptional()
  reason?: (typeof BLOCK_REASONS)[number];
}
