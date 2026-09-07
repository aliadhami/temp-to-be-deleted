import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleKey } from '../../identity/domain/role-key.enum';
import { Roles } from '../../identity/infrastructure/decorators/roles.decorator';
import { AdminGetCardUseCase } from '../application/admin-get-card.usecase';
import { AdminListCardsQueryDto } from './dto/admin-list-cards-query.dto';

@ApiTags('admin-cards')
@ApiBearerAuth()
@Roles(RoleKey.ADMIN)
@Controller('admin/cards')
export class AdminCardsController {
  constructor(private readonly adminGetCardUseCase: AdminGetCardUseCase) {}

  @Get()
  list(@Query() query: AdminListCardsQueryDto) {
    return this.adminGetCardUseCase.listAll({
      ...query,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
  }

  @Get(':publicId')
  getOne(@Param('publicId') publicId: string) {
    return this.adminGetCardUseCase.getByPublicId(publicId);
  }
}
