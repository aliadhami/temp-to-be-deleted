import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleKey } from '../../identity/domain/role-key.enum';
import { Roles } from '../../identity/infrastructure/decorators/roles.decorator';
import { PartnerManagementService } from '../application/partner-management.service';
import { CurrentPartnerId } from '../infrastructure/decorators/current-partner-id.decorator';
import { PartnerScopeGuard } from '../infrastructure/partner-scope.guard';
import { SetCheckoutReturnUrlDto } from './dto/set-checkout-return-url.dto';
import { SetPartnerWebhookDto } from './dto/set-webhook.dto';

@ApiTags('dashboard')
@ApiBearerAuth()
@Roles(RoleKey.PARTNER)
@UseGuards(PartnerScopeGuard)
@Controller('dashboard/settings')
export class DashboardSettingsController {
  constructor(
    private readonly partnerManagementService: PartnerManagementService,
  ) {}

  @Get()
  get(@CurrentPartnerId() partnerId: string) {
    return this.partnerManagementService.getForPartnerId(partnerId);
  }

  @Post('webhook')
  setWebhook(
    @CurrentPartnerId() partnerId: string,
    @Body() dto: SetPartnerWebhookDto,
  ) {
    return this.partnerManagementService.setWebhookForPartnerId(
      partnerId,
      dto.webhookUrl,
    );
  }

  @Patch('checkout-return-url')
  setCheckoutReturnUrl(
    @CurrentPartnerId() partnerId: string,
    @Body() dto: SetCheckoutReturnUrlDto,
  ) {
    return this.partnerManagementService.setCheckoutReturnUrlForPartnerId(
      partnerId,
      dto.checkoutReturnUrl,
    );
  }
}
