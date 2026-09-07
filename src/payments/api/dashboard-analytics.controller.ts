import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleKey } from '../../identity/domain/role-key.enum';
import { Roles } from '../../identity/infrastructure/decorators/roles.decorator';
import { CurrentPartnerId } from '../../partners/infrastructure/decorators/current-partner-id.decorator';
import { PartnerScopeGuard } from '../../partners/infrastructure/partner-scope.guard';
import { AnalyticsService } from '../application/analytics.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';

@ApiTags('dashboard')
@ApiBearerAuth()
@Roles(RoleKey.PARTNER)
@UseGuards(PartnerScopeGuard)
@Controller('dashboard/analytics')
export class DashboardAnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('kpis')
  getKpis(
    @CurrentPartnerId() partnerId: string,
    @Query() query: AnalyticsQueryDto,
  ) {
    // Hardcode the authenticated partnerId to guarantee strict data isolation
    return this.analyticsService.getDashboardMetrics({
      ...query,
      partnerId,
    });
  }
}
