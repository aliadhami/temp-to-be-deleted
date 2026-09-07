import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleKey } from '../../identity/domain/role-key.enum';
import { Roles } from '../../identity/infrastructure/decorators/roles.decorator';
import { PartnerApiKeyService } from '../application/partner-api-key.service';
import { PartnerManagementService } from '../application/partner-management.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { CreatePartnerDto } from './dto/create-partner.dto';
import { SetPartnerCredentialsDto } from './dto/set-credentials.dto';
import { SetPartnerWebhookDto } from './dto/set-webhook.dto';
import { UpdatePartnerDto } from './dto/update-partner.dto';
import { CreatePartnerUserDto } from './dto/create-partner-user.dto';
import { PartnerUserService } from '../application/partner-user.service';

@ApiTags('partners')
@ApiBearerAuth()
@Roles(RoleKey.ADMIN)
@Controller('partners')
export class PartnersController {
  constructor(
    private readonly partnerManagementService: PartnerManagementService,
    private readonly apiKeyService: PartnerApiKeyService,
    private readonly partnerUserService: PartnerUserService,
  ) {}

  @Post()
  create(@Body() dto: CreatePartnerDto) {
    return this.partnerManagementService.create(dto);
  }

  @Get()
  list() {
    return this.partnerManagementService.list();
  }

  @Get(':publicId')
  getOne(@Param('publicId') publicId: string) {
    return this.partnerManagementService.getByPublicId(publicId);
  }

  @Patch(':publicId')
  update(@Param('publicId') publicId: string, @Body() dto: UpdatePartnerDto) {
    return this.partnerManagementService.update(publicId, dto);
  }

  @Post(':publicId/credentials')
  setCredentials(
    @Param('publicId') publicId: string,
    @Body() dto: SetPartnerCredentialsDto,
  ) {
    return this.partnerManagementService.setCredentials(
      publicId,
      dto.gatewayKey,
      dto.environment,
      dto.credentials,
    );
  }

  @Post(':publicId/webhook')
  setWebhook(
    @Param('publicId') publicId: string,
    @Body() dto: SetPartnerWebhookDto,
  ) {
    return this.partnerManagementService.setWebhook(publicId, dto.webhookUrl);
  }

  @Post(':publicId/api-keys')
  createApiKey(
    @Param('publicId') publicId: string,
    @Body() dto: CreateApiKeyDto,
  ) {
    return this.apiKeyService.create(publicId, dto.scopes, dto.label);
  }

  @Get(':publicId/api-keys')
  listApiKeys(@Param('publicId') publicId: string) {
    return this.apiKeyService.list(publicId);
  }

  @Delete(':publicId/api-keys/:keyId')
  revokeApiKey(
    @Param('publicId') publicId: string,
    @Param('keyId') keyId: string,
  ) {
    return this.apiKeyService.revoke(publicId, keyId);
  }
  @Post(':publicId/users')
  createPartnerUser(
    @Param('publicId') publicId: string,
    @Body() dto: CreatePartnerUserDto,
  ) {
    return this.partnerUserService.create(publicId, dto);
  }

  @Get(':publicId/users')
  listPartnerUsers(@Param('publicId') publicId: string) {
    return this.partnerUserService.list(publicId);
  }
}
