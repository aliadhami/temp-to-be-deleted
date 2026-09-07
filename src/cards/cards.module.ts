import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PartnersModule } from '../partners/partners.module';
import { PaymentsModule } from '../payments/payments.module';
import { ActivateCardUseCase } from './application/activate-card.usecase';
import { GetCardUseCase } from './application/get-card.usecase';
import { GetMerchantBalanceUseCase } from './application/get-merchant-balance.usecase';
import { GetCardholderUseCase } from './application/get-cardholder.usecase';
import { IssueCardUseCase } from './application/issue-card.usecase';
import { OnboardCardholderUseCase } from './application/onboard-cardholder.usecase';
import { ReconcileCardholdersUseCase } from './application/reconcile-cardholders.usecase';
import { ReconcileNotActivatedCardsUseCase } from './application/reconcile-not-activated-cards.usecase';
import { ResolveCardApplicationsUseCase } from './application/resolve-card-applications.usecase';
import { SubmitKycUseCase } from './application/submit-kyc.usecase';
import { CardCallbacksController } from './api/card-callbacks.controller';
import { CardholdersController } from './api/cardholders.controller';
import { CardsController } from './api/cards.controller';
import { CardIssuerRegistry } from './infrastructure/card-issuer-registry';
import { CardApplicationEntity } from './infrastructure/persistence/card-application.entity';
import { CardDepositEntity } from './infrastructure/persistence/card-deposit.entity';
import { CardEventEntity } from './infrastructure/persistence/card-event.entity';
import { CardOperationEntity } from './infrastructure/persistence/card-operation.entity';
import { CardProductEntity } from './infrastructure/persistence/card-product.entity';
import { CardProviderCallbackEntity } from './infrastructure/persistence/card-provider-callback.entity';
import { CardEntity } from './infrastructure/persistence/card.entity';
import { CardholderEventEntity } from './infrastructure/persistence/cardholder-event.entity';
import { CardholderEntity } from './infrastructure/persistence/cardholder.entity';
import { AxysHttpClient } from './infrastructure/providers/axys/axys-http-client.service';
import { AxysSignatureService } from './infrastructure/providers/axys/axys-signature.service';
import { AxysAdapter } from './infrastructure/providers/axys/axys.adapter';
import { HyperCardCardDetailKeyService } from './infrastructure/providers/hypercard/hypercard-card-detail-key.service';
import { HyperCardHttpClient } from './infrastructure/providers/hypercard/hypercard-http-client.service';
import { HyperCardMockService } from './infrastructure/providers/hypercard/hypercard-mock.service';
import { HyperCardPlatformKeyService } from './infrastructure/providers/hypercard/hypercard-platform-key.service';
import { HyperCardSignatureService } from './infrastructure/providers/hypercard/hypercard-signature.service';
import { HyperCardAdapter } from './infrastructure/providers/hypercard/hypercard.adapter';
import { CardApplicationSweepService } from './infrastructure/card-application-sweep.service';
import { ReconcileCardholdersSweepService } from './infrastructure/reconcile-cardholders-sweep.service';
import { CardholderStatusSyncService } from './application/cardholder-status-sync.service';
import { EmulateKycValidationUseCase } from './application/emulate-kyc-validation.usecase';
import { AdminCardEmulationController } from './api/admin-card-emulation.controller';
import { AdminCardIssuersController } from './api/admin-card-issuers.controller';
import { AxysEmulationService } from './infrastructure/providers/axys/axys-emulation.service';
import { RevealSensitiveCardDetailsUseCase } from './application/reveal-sensitive-card-details.usecase';
import { SyncCardholderStatusUseCase } from './application/sync-cardholder-status.usecase';
import { ReconcileCardBalancesUseCase } from './application/reconcile-card-balances.usecase';
import { ReconcileCardsSweepService } from './infrastructure/reconcile-cards-sweep.service';
import { GetCardDepositAddressUseCase } from './application/get-card-deposit-address.usecase';
import { GetCardDepositsUseCase } from './application/get-card-deposits.usecase';
import { QuoteCardDepositUseCase } from './application/quote-card-deposit.usecase';
import { QuoteCardFundingUseCase } from './application/quote-card-funding.usecase';
import { RequestCardDepositUseCase } from './application/request-card-deposit.usecase';
import { ResolveCardDepositsUseCase } from './application/resolve-card-deposits.usecase';
import { CardDepositSweepService } from './infrastructure/card-deposit-sweep.service';
import { CardOperationSweepService } from './infrastructure/card-operation-sweep.service';
import { ResolveCardOperationsUseCase } from './application/resolve-card-operations.usecase';
import { SimulateCardDepositUseCase } from './application/simulate-card-deposit.usecase';
import { SimulateCardSpendUseCase } from './application/simulate-card-spend.usecase';
import { PrepareSpendOtpUseCase } from './application/prepare-spend-otp.usecase';
import { MockHyperCardConsumeUseCase } from './application/mock-hypercard-consume.usecase';
import { MockHyperCardMerchantBalanceUseCase } from './application/mock-hypercard-merchant-balance.usecase';
import { UpdateCardStatusUseCase } from './application/update-card-status.usecase';
import { UpdateCardPinUseCase } from './application/update-card-pin.usecase';
import { ListCardTransactionsUseCase } from './application/list-card-transactions.usecase';
import { SyncCardProductsUseCase } from './application/sync-card-products.usecase';
import { ListCardProductsUseCase } from './application/list-card-products.usecase';
import { CardOperationAvailability } from './application/card-operation-availability';
import { CardProductResolver } from './application/card-product-resolver';
import { AuditService } from '../payments/infrastructure/audit/audit.service';
import { AdminCardholdersController } from './api/admin-cardholders.controller';
import { AdminCardsController } from './api/admin-cards.controller';
import { AdminGetCardUseCase } from './application/admin-get-card.usecase';
import { AdminGetCardholderUseCase } from './application/admin-get-cardholder.usecase';
import { CardholderEnrolmentEntity } from './infrastructure/persistence/cardholder-enrolment.entity';
import { CardholderEnrolmentResolver } from './application/cardholder-enrolment.resolver';
import { CardholderEnrolmentService } from './application/cardholder-enrolment.service';
import { EnrolCardholderUseCase } from './application/enrol-cardholder.usecase';
import { ProcessCardProviderCallbackUseCase } from './application/process-card-provider-callback.usecase';
import { CardProviderCallbackDispatcher } from './application/card-provider-callback.dispatcher';
import { ApplyIssuerCardStatusUseCase } from './application/apply-issuer-card-status.usecase';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CardholderEntity,
      CardholderEnrolmentEntity,
      CardholderEventEntity,
      CardEntity,
      CardEventEntity,
      CardProductEntity,
      CardApplicationEntity,
      CardDepositEntity,
      CardOperationEntity,
      CardProviderCallbackEntity,
    ]),
    PartnersModule,
    PaymentsModule, // for WebhookDeliveryService reuse
  ],
  controllers: [
    CardholdersController,
    CardsController,
    CardCallbacksController,
    AdminCardEmulationController,
    AdminCardholdersController,
    AdminCardIssuersController,
    AdminCardsController,
  ],
  providers: [
    AxysSignatureService,
    AxysHttpClient,
    AxysAdapter,
    HyperCardSignatureService,
    HyperCardHttpClient,
    // The keypair their card-detail endpoint encrypts under — separate from the
    // signing key in every sense, including this one: nothing reads it until a
    // reveal actually happens.
    HyperCardCardDetailKeyService,
    // Their own public key, the one their callbacks are signed with — read on
    // first use for the same reason as the keypair above.
    HyperCardPlatformKeyService,
    HyperCardAdapter,
    // Refused unless PAYMENTS_HYPERCARD_ENV is sandbox. Two of its five
    // endpoints have routes; the other three have no caller.
    HyperCardMockService,
    CardholderEnrolmentResolver,
    CardholderEnrolmentService,
    OnboardCardholderUseCase,
    EnrolCardholderUseCase,
    SubmitKycUseCase,
    GetCardholderUseCase,
    ReconcileCardholdersUseCase,
    ReconcileCardholdersSweepService,
    IssueCardUseCase,
    // Turns an acknowledged card application into a card, for the issuers that
    // report the outcome separately from the call that made it.
    ResolveCardApplicationsUseCase,
    // And watches that card the rest of the way to usable, for the issuers
    // whose activation settles after the call rather than on it. Both run on
    // the one sweep below.
    ReconcileNotActivatedCardsUseCase,
    CardApplicationSweepService,
    ActivateCardUseCase,
    GetCardUseCase,
    GetMerchantBalanceUseCase,
    CardholderStatusSyncService,
    AxysEmulationService,
    EmulateKycValidationUseCase,
    RevealSensitiveCardDetailsUseCase,
    SyncCardholderStatusUseCase,
    ReconcileCardBalancesUseCase,
    ReconcileCardsSweepService,
    GetCardDepositAddressUseCase,
    QuoteCardFundingUseCase,
    QuoteCardDepositUseCase,
    RequestCardDepositUseCase,
    GetCardDepositsUseCase,
    ResolveCardDepositsUseCase,
    CardDepositSweepService,
    SimulateCardDepositUseCase,
    SimulateCardSpendUseCase,
    PrepareSpendOtpUseCase,
    MockHyperCardConsumeUseCase,
    MockHyperCardMerchantBalanceUseCase,
    UpdateCardStatusUseCase,
    ResolveCardOperationsUseCase,
    CardOperationSweepService,
    UpdateCardPinUseCase,
    ListCardTransactionsUseCase,
    SyncCardProductsUseCase,
    ListCardProductsUseCase,
    CardOperationAvailability,
    CardProductResolver,
    AuditService,
    AdminGetCardholderUseCase,
    AdminGetCardUseCase,
    ProcessCardProviderCallbackUseCase,
    // What a verified callback is acted on by: it re-asks the issuer through
    // the same use cases the timers drive, so a push and a tick produce one
    // outcome.
    CardProviderCallbackDispatcher,
    // The only thing that ever notices a status change the issuer made itself;
    // no pass re-reads a card once it is active.
    ApplyIssuerCardStatusUseCase,
    {
      // The registry is not auto-discovered: this array is the enable-list at
      // the DI level, and `inject` below must stay in lockstep with the factory
      // parameters. Adding an adapter to one and not the other compiles fine
      // and fails at runtime.
      provide: CardIssuerRegistry,
      useFactory: (
        configService: ConfigService,
        axysAdapter: AxysAdapter,
        hyperCardAdapter: HyperCardAdapter,
      ) =>
        new CardIssuerRegistry(configService, [axysAdapter, hyperCardAdapter]),
      inject: [ConfigService, AxysAdapter, HyperCardAdapter],
    },
  ],
  exports: [TypeOrmModule],
})
export class CardsModule {}
