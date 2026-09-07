import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { ListCardholdersQueryDto } from './list-cardholders-query.dto';

export class AdminListCardholdersQueryDto extends ListCardholdersQueryDto {
  @ApiProperty({
    required: false,
    description: 'Filter to cardholders belonging to one partner',
  })
  @IsOptional()
  @IsUUID()
  partnerPublicId?: string;
}
