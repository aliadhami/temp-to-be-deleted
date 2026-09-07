import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleKey } from '../../identity/domain/role-key.enum';
import { Roles } from '../../identity/infrastructure/decorators/roles.decorator';
import { CurrentPartnerId } from '../../partners/infrastructure/decorators/current-partner-id.decorator';
import { PartnerScopeGuard } from '../../partners/infrastructure/partner-scope.guard';
import { WebhookDeliveriesQueryService } from '../application/webhook-deliveries-query.service';
import { ListWebhookDeliveriesQueryDto } from './dto/list-webhook-deliveries-query.dto';

@ApiTags('dashboard')
@ApiBearerAuth()
@Roles(RoleKey.PARTNER)
@UseGuards(PartnerScopeGuard)
@Controller('dashboard/webhooks')
export class DashboardWebhooksController {
  constructor(private readonly queryService: WebhookDeliveriesQueryService) {}

  @Get()
  list(
    @CurrentPartnerId() partnerId: string,
    @Query() query: ListWebhookDeliveriesQueryDto,
  ) {
    return this.queryService.listForPartner(
      partnerId,
      query.page ?? 1,
      query.limit ?? 20,
      query.status,
    );
  }

  @Get(':publicId')
  getOne(
    @CurrentPartnerId() partnerId: string,
    @Param('publicId') publicId: string,
  ) {
    return this.queryService.getOneForPartner(partnerId, publicId);
  }
}
