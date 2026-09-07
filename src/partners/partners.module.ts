import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module';
import { CryptoModule } from '../shared/crypto/crypto.module';
import { PartnersController } from './api/partners.controller';
import { PartnerApiKeyService } from './application/partner-api-key.service';
import { PartnerManagementService } from './application/partner-management.service';
import { PartnerUserService } from './application/partner-user.service';
import { PartnerApiKeyGuard } from './infrastructure/partner-api-key.guard';
import { PartnerApiKeyEntity } from './persistence/partner-api-key.entity';
import { PartnerGatewayCredentialEntity } from './persistence/partner-gateway-credential.entity';
import { PartnerEntity } from './persistence/partner.entity';
import { PartnerScopeGuard } from './infrastructure/partner-scope.guard';
import { DashboardApiKeysController } from './api/dashboard-api-keys.controller';
import { DashboardSettingsController } from './api/dashboard-settings.controller';
@Module({
  imports: [
    TypeOrmModule.forFeature([
      PartnerEntity,
      PartnerGatewayCredentialEntity,
      PartnerApiKeyEntity,
    ]),
    CryptoModule,
    IdentityModule,
  ],
  controllers: [
    PartnersController,
    DashboardApiKeysController,
    DashboardSettingsController,
  ],
  providers: [
    PartnerManagementService,
    PartnerApiKeyService,
    PartnerApiKeyGuard,
    PartnerUserService,
    PartnerScopeGuard,
  ],
  exports: [
    TypeOrmModule,
    PartnerApiKeyService,
    PartnerApiKeyGuard,
    PartnerScopeGuard,
  ],
})
export class PartnersModule {}
