import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { ListCardsQueryDto } from './list-cards-query.dto';

export class AdminListCardsQueryDto extends ListCardsQueryDto {
  @ApiProperty({
    required: false,
    description: 'Filter to cards belonging to one partner',
  })
  @IsOptional()
  @IsUUID()
  partnerPublicId?: string;
}
