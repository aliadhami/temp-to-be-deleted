import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsString,
  MinLength,
} from 'class-validator';
import { RoleKey } from '../../domain/role-key.enum';

const STAFF_ROLES = [
  RoleKey.ADMIN,
  RoleKey.FINANCE,
  RoleKey.OPERATOR,
  RoleKey.APPROVER,
  RoleKey.AUDITOR,
] as const;

export class CreateUserDto {
  @ApiProperty({ example: 'finance@yourdomain.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 12 })
  @IsString()
  @MinLength(12)
  password!: string;

  @ApiProperty({ example: 'Jane Finance' })
  @IsString()
  @MinLength(2)
  displayName!: string;

  @ApiProperty({
    enum: STAFF_ROLES,
    isArray: true,
    example: [RoleKey.FINANCE],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(STAFF_ROLES, { each: true })
  roles!: RoleKey[];
}

export { STAFF_ROLES };
