import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleKey } from '../../identity/domain/role-key.enum';
import { Roles } from '../../identity/infrastructure/decorators/roles.decorator';
import { AnalyticsService } from '../application/analytics.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';

@ApiTags('admin-analytics')
@ApiBearerAuth()
@Roles(RoleKey.ADMIN, RoleKey.OPERATOR, RoleKey.AUDITOR, RoleKey.FINANCE)
@Controller('admin/analytics')
export class AdminAnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('kpis')
  getKpis(@Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getDashboardMetrics(query);
  }
}
