import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleKey } from '../../identity/domain/role-key.enum';
import { Roles } from '../../identity/infrastructure/decorators/roles.decorator';
import { PartnerApiKeyService } from '../application/partner-api-key.service';
import { CurrentPartnerId } from '../infrastructure/decorators/current-partner-id.decorator';
import { PartnerScopeGuard } from '../infrastructure/partner-scope.guard';
import { CreatePartnerApiKeyDto } from './dto/create-partner-api-key.dto';

@ApiTags('dashboard')
@ApiBearerAuth()
@Roles(RoleKey.PARTNER)
@UseGuards(PartnerScopeGuard)
@Controller('dashboard/api-keys')
export class DashboardApiKeysController {
  constructor(private readonly apiKeyService: PartnerApiKeyService) {}

  @Post()
  create(
    @CurrentPartnerId() partnerId: string,
    @Body() dto: CreatePartnerApiKeyDto,
  ) {
    return this.apiKeyService.createForPartnerId(
      partnerId,
      dto.scopes,
      dto.label,
    );
  }

  @Get()
  list(@CurrentPartnerId() partnerId: string) {
    return this.apiKeyService.listForPartnerId(partnerId);
  }

  @Delete(':keyId')
  revoke(@CurrentPartnerId() partnerId: string, @Param('keyId') keyId: string) {
    return this.apiKeyService.revokeForPartnerId(partnerId, keyId);
  }
}
