import { ApiProperty } from '@nestjs/swagger';
import { RoleKey } from '../../domain/role-key.enum';
import { UserStatus } from '../../domain/user-status.enum';

export class UserResponseDto {
  @ApiProperty() publicId!: string;
  @ApiProperty() email!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ enum: UserStatus }) status!: UserStatus;
  @ApiProperty({ enum: RoleKey, isArray: true }) roles!: RoleKey[];
  @ApiProperty() createdAt!: Date;
}
