import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, ArrayUnique, IsArray, IsEnum } from 'class-validator';
import { RoleKey } from '../../domain/role-key.enum';
import { STAFF_ROLES } from './create-user.dto';

export class UpdateUserRolesDto {
  @ApiProperty({ enum: STAFF_ROLES, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(STAFF_ROLES, { each: true })
  roles!: RoleKey[];
}
