import { Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleKey } from '../../identity/domain/role-key.enum';
import { Roles } from '../../identity/infrastructure/decorators/roles.decorator';
import { WebhookDeliveriesQueryService } from '../application/webhook-deliveries-query.service';

@ApiTags('webhook-deliveries')
@ApiBearerAuth()
@Roles(RoleKey.ADMIN)
@Controller('webhook-deliveries')
export class WebhookDeliveriesController {
  constructor(private readonly queryService: WebhookDeliveriesQueryService) {}

  @Get()
  list(@Query('status') status?: string) {
    return this.queryService.list(status);
  }

  @Patch(':publicId/retry')
  retry(@Param('publicId') publicId: string) {
    return this.queryService.retryDeadLetter(publicId);
  }
}
