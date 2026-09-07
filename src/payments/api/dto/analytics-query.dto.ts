import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsDateString } from 'class-validator';

export class AnalyticsQueryDto {
  @ApiProperty({
    required: false,
    description: 'Filter by specific Partner ID (Admin only)',
  })
  @IsOptional()
  @IsString()
  partnerId?: string;

  @ApiProperty({
    required: false,
    description: 'Filter by specific Gateway (e.g., MLT, SUNPAY)',
  })
  @IsOptional()
  @IsString()
  gatewayKey?: string;

  @ApiProperty({ required: false, description: 'Start date in ISO format' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiProperty({ required: false, description: 'End date in ISO format' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}
