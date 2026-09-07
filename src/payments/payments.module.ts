import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PartnersModule } from '../partners/partners.module';
import { CryptoModule } from '../shared/crypto/crypto.module';
import { AdminPaymentsController } from './api/admin-payments.controller';
import { GatewayCallbacksController } from './api/gateway-callbacks.controller';
import { PaymentsController } from './api/payments.controller';
import { WebhookDeliveriesController } from './api/webhook-deliveries.controller';
import { DashboardPaymentsController } from './api/dashboard-payments.controller';
import { DashboardWebhooksController } from './api/dashboard-webhooks.controller';
import { AdminAnalyticsController } from './api/admin-analytics.controller';
import { DashboardAnalyticsController } from './api/dashboard-analytics.controller';
import { GetPaymentUseCase } from './application/get-payment.usecase';
import { InitiatePaymentUseCase } from './application/initiate-payment.usecase';
import { ProcessGatewayResultUseCase } from './application/process-gateway-result.usecase';
import { WebhookDeliveriesQueryService } from './application/webhook-deliveries-query.service';
import { AnalyticsService } from './application/analytics.service';
import { AuditLogEntity } from './infrastructure/audit/audit-log.entity';
import { AuditService } from './infrastructure/audit/audit.service';
import { CredentialResolver } from './infrastructure/credentials/credential-resolver';
import { GatewayRegistry } from './infrastructure/gateway-registry';
import { MltSecureHashService } from './infrastructure/gateways/mlt/mlt-secure-hash.service';
import { MltAdapter } from './infrastructure/gateways/mlt/mlt.adapter';
import { SunPayHttpClient } from './infrastructure/gateways/sunpay/sunpay-http-client.service';
import { SunPaySignatureService } from './infrastructure/gateways/sunpay/sunpay-signature.service';
import { SunPayAdapter } from './infrastructure/gateways/sunpay/sunpay.adapter';
import { FeeRecordEntity } from './infrastructure/persistence/fee-record.entity';
import { GatewayCallbackLogEntity } from './infrastructure/persistence/gateway-callback-log.entity';
import { PaymentTransactionEntity } from './infrastructure/persistence/payment-transaction.entity';
import { PayoutApprovalEntity } from './infrastructure/persistence/payout-approval.entity';
import { PayoutEntity } from './infrastructure/persistence/payout.entity';
import { RefundEntity } from './infrastructure/persistence/refund.entity';
import { RoutingRuleEntity } from './infrastructure/persistence/routing-rule.entity';
import { TransactionEventEntity } from './infrastructure/persistence/transaction-event.entity';
import { WebhookDeliveryEntity } from './infrastructure/webhooks/webhook-delivery.entity';
import { WebhookDeliveryService } from './infrastructure/webhooks/webhook-delivery.service';
import { WebhookRetrySweepService } from './infrastructure/webhooks/webhook-retry-sweep.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PaymentTransactionEntity,
      TransactionEventEntity,
      RefundEntity,
      PayoutEntity,
      PayoutApprovalEntity,
      RoutingRuleEntity,
      GatewayCallbackLogEntity,
      FeeRecordEntity,
      AuditLogEntity,
      WebhookDeliveryEntity,
    ]),
    PartnersModule,
    CryptoModule,
  ],
  controllers: [
    PaymentsController,
    GatewayCallbacksController,
    WebhookDeliveriesController,
    AdminPaymentsController,
    DashboardPaymentsController,
    DashboardWebhooksController,
    AdminAnalyticsController,
    DashboardAnalyticsController,
  ],
  providers: [
    CredentialResolver,
    MltSecureHashService,
    MltAdapter,
    SunPaySignatureService,
    SunPayHttpClient,
    SunPayAdapter,
    AuditService,
    InitiatePaymentUseCase,
    GetPaymentUseCase,
    ProcessGatewayResultUseCase,
    WebhookDeliveryService,
    WebhookRetrySweepService,
    WebhookDeliveriesQueryService,
    AnalyticsService,
    {
      // This array is the actual enable-list at the DI level. An adapter absent
      // here fails at boot with "references unknown gateway adapter(s)", even
      // though its enum value and env vars exist.
      provide: GatewayRegistry,
      useFactory: (
        configService: ConfigService,
        mltAdapter: MltAdapter,
        sunPayAdapter: SunPayAdapter,
      ) => new GatewayRegistry(configService, [mltAdapter, sunPayAdapter]),
      inject: [ConfigService, MltAdapter, SunPayAdapter],
    },
  ],
  exports: [
    TypeOrmModule,
    CredentialResolver,
    GatewayRegistry,
    WebhookDeliveryService,
  ],
})
export class PaymentsModule {}
