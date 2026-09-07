import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../infrastructure/decorators/roles.decorator';
import { RoleKey } from '../domain/role-key.enum';
import { UserManagementService } from '../application/user-management.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserRolesDto } from './dto/update-user-roles.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';

@ApiTags('users')
@ApiBearerAuth()
@Roles(RoleKey.ADMIN)
@Controller('users')
export class UsersController {
  constructor(private readonly userManagementService: UserManagementService) {}

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.userManagementService.createStaffUser(dto);
  }

  @Get()
  list() {
    return this.userManagementService.listUsers();
  }

  @Get(':publicId')
  getOne(@Param('publicId') publicId: string) {
    return this.userManagementService.getUserByPublicId(publicId);
  }

  @Patch(':publicId/status')
  updateStatus(
    @Param('publicId') publicId: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.userManagementService.updateStatus(publicId, dto.status);
  }

  @Patch(':publicId/roles')
  updateRoles(
    @Param('publicId') publicId: string,
    @Body() dto: UpdateUserRolesDto,
  ) {
    return this.userManagementService.updateRoles(publicId, dto.roles);
  }
}
