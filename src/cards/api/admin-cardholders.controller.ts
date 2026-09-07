import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleKey } from '../../identity/domain/role-key.enum';
import { Roles } from '../../identity/infrastructure/decorators/roles.decorator';
import { AdminGetCardholderUseCase } from '../application/admin-get-cardholder.usecase';
import { AdminListCardholdersQueryDto } from './dto/admin-list-cardholders-query.dto';

@ApiTags('admin-cards')
@ApiBearerAuth()
@Roles(RoleKey.ADMIN)
@Controller('admin/cardholders')
export class AdminCardholdersController {
  constructor(
    private readonly adminGetCardholderUseCase: AdminGetCardholderUseCase,
  ) {}

  @Get()
  list(@Query() query: AdminListCardholdersQueryDto) {
    return this.adminGetCardholderUseCase.listAll({
      ...query,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
  }

  @Get(':publicId')
  getOne(@Param('publicId') publicId: string) {
    return this.adminGetCardholderUseCase.getByPublicId(publicId);
  }
}
