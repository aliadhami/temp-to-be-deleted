import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { PartnerEntity } from '../../partners/persistence/partner.entity';
import { GatewayCallbackContext } from '../domain/payment-gateway.port';
import { GatewayKey } from '../domain/gateway-key.enum';
import { PaymentStatus } from '../domain/payment-status.enum';
import { TransactionEventSource } from '../domain/transaction-event-source.enum';
import { AuditService } from '../infrastructure/audit/audit.service';
import { CredentialResolver } from '../infrastructure/credentials/credential-resolver';
import { resolveGatewayEnvironment } from '../infrastructure/credentials/gateway-environment.util';
import { GatewayRegistry } from '../infrastructure/gateway-registry';
import { GatewayCallbackLogEntity } from '../infrastructure/persistence/gateway-callback-log.entity';
import { PaymentTransactionEntity } from '../infrastructure/persistence/payment-transaction.entity';
import { TransactionEventEntity } from '../infrastructure/persistence/transaction-event.entity';
import { WebhookDeliveryService } from '../infrastructure/webhooks/webhook-delivery.service';

const TERMINAL_STATUSES = new Set<PaymentStatus>([
  PaymentStatus.PAID,
  PaymentStatus.FAILED,
  PaymentStatus.REJECTED,
  PaymentStatus.CANCELLED,
  PaymentStatus.ERROR,
  PaymentStatus.REFUNDED,
  PaymentStatus.PARTIALLY_REFUNDED,
]);

interface LedgerUpdateExtras {
  reasonCode?: string;
  message?: string;
  providerRef?: string;
  responsePayload: Record<string, unknown>;
}

export type CallbackResponse =
  | { kind: 'REDIRECT'; url: string }
  | { kind: 'ACK'; status: number; body: string; contentType: string };

const buildRedirectUrl = (
  checkoutReturnUrl: string,
  publicId: string,
): string | null => {
  try {
    const url = new URL(checkoutReturnUrl);
    url.searchParams.set('publicId', publicId);
    return url.toString();
  } catch {
    return null;
  }
};

@Injectable()
export class ProcessGatewayResultUseCase {
  private readonly logger = new Logger(ProcessGatewayResultUseCase.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(PaymentTransactionEntity)
    private readonly transactionRepository: Repository<PaymentTransactionEntity>,
    @InjectRepository(GatewayCallbackLogEntity)
    private readonly callbackLogRepository: Repository<GatewayCallbackLogEntity>,
    @InjectRepository(PartnerEntity)
    private readonly partnerRepository: Repository<PartnerEntity>,
    private readonly gatewayRegistry: GatewayRegistry,
    private readonly credentialResolver: CredentialResolver,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly webhookDeliveryService: WebhookDeliveryService,
  ) {}

  async execute(
    gatewayKey: GatewayKey,
    context: GatewayCallbackContext,
  ): Promise<CallbackResponse> {
    const adapter = this.gatewayRegistry.resolve(gatewayKey);
    const payload = context.payload as Record<string, unknown>;

    // Ask the adapter where ITS callbacks carry our reference. This used to read
    // `payload.RequestId` directly — MLT's field name — which meant any provider
    // that nests or renames it (SunPay: data.out_order_no) silently found no
    // transaction, acked the webhook, and lost the result permanently.
    const requestId = adapter.extractRequestId(context);

    const transaction = requestId
      ? await this.transactionRepository.findOne({
          where: { gatewayKey, requestId },
        })
      : null;

    let signatureValid = false;
    let mappedStatus: PaymentStatus = PaymentStatus.ERROR;
    let reasonCode: string | undefined;
    let message: string | undefined;
    let providerRef: string | undefined;

    if (transaction) {
      const environment = resolveGatewayEnvironment(
        this.configService,
        gatewayKey,
      );
      const credentials = await this.credentialResolver.resolve({
        gatewayKey,
        partnerId: transaction.partnerId,
        environment,
      });

      const verification = await adapter.verifyResult(context, credentials);
      signatureValid = verification.signatureValid;
      mappedStatus = verification.status;
      reasonCode = verification.reasonCode;
      message = verification.message;
      providerRef = verification.refs.providerRef;
    } else {
      this.logger.warn(
        `Gateway callback for unknown transaction: gatewayKey=${gatewayKey} requestId=${requestId ?? 'MISSING'}`,
      );
    }

    await this.callbackLogRepository.save(
      this.callbackLogRepository.create({
        gatewayKey,
        transactionPublicId: transaction?.publicId ?? null,
        signatureValid,
        rawPayload: payload,
        receivedAt: new Date(),
      }),
    );

    if (transaction && signatureValid) {
      await this.applyResultToLedger(transaction, mappedStatus, {
        ...(reasonCode !== undefined && { reasonCode }),
        ...(message !== undefined && { message }),
        ...(providerRef !== undefined && { providerRef }),
        responsePayload: payload,
      });
    }

    // Browser-redirect gateways: send the customer onward to the partner's
    // checkout return page whenever we can identify the transaction — this
    // applies even when the signature was invalid, since we're only
    // navigating the browser, not asserting a payment outcome. The
    // partner's own frontend determines final status via GET /payments/:id.
    if (transaction?.partnerId && adapter.supportsBrowserRedirect) {
      const partner = await this.partnerRepository.findOne({
        where: { id: transaction.partnerId },
      });
      if (partner?.checkoutReturnUrl) {
        const redirectUrl = buildRedirectUrl(
          partner.checkoutReturnUrl,
          transaction.publicId,
        );
        if (redirectUrl) {
          return { kind: 'REDIRECT', url: redirectUrl };
        }
      }
    }

    const ack = adapter.callbackAck();
    return {
      kind: 'ACK',
      status: ack.status,
      body: ack.body,
      // text/plain is the safe default: an unlabelled string body is readable
      // either way, whereas a wrong application/json breaks any client that
      // parses by header.
      contentType: ack.contentType ?? 'text/plain',
    };
  }

  private async applyResultToLedger(
    transaction: PaymentTransactionEntity,
    newStatus: PaymentStatus,
    extra: LedgerUpdateExtras,
  ): Promise<void> {
    let statusActuallyChanged = false;

    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(PaymentTransactionEntity);
      const eventRepo = manager.getRepository(TransactionEventEntity);

      const locked = await repo
        .createQueryBuilder('txn')
        .setLock('pessimistic_write')
        .where('txn.id = :id', { id: transaction.id })
        .getOne();
      if (!locked) return;

      if (TERMINAL_STATUSES.has(locked.status)) {
        await eventRepo.save(
          eventRepo.create({
            transactionId: locked.id,
            fromStatus: locked.status,
            toStatus: locked.status,
            source: TransactionEventSource.CALLBACK,
            detail:
              'Duplicate callback ignored — transaction already finalized',
          }),
        );
        return;
      }

      const previousStatus = locked.status;
      locked.status = newStatus;
      locked.reasonCode = extra.reasonCode ?? null;
      locked.message = extra.message ?? null;
      if (extra.providerRef) locked.providerRef = extra.providerRef;
      locked.responsePayload = extra.responsePayload;
      locked.completedAt = new Date();
      await repo.save(locked);

      await eventRepo.save(
        eventRepo.create({
          transactionId: locked.id,
          fromStatus: previousStatus,
          toStatus: newStatus,
          source: TransactionEventSource.CALLBACK,
          detail: extra.message ?? null,
        }),
      );

      statusActuallyChanged = true;
    });

    if (!statusActuallyChanged) return;

    await this.auditService.record({
      actorUserId: null,
      action: 'PAYMENT_STATUS_UPDATED',
      targetType: 'payment_transaction',
      targetPublicId: transaction.publicId,
      afterJson: {
        status: newStatus,
        ...(extra.reasonCode !== undefined && { reasonCode: extra.reasonCode }),
        ...(extra.providerRef !== undefined && {
          providerRef: extra.providerRef,
        }),
      },
    });

    if (TERMINAL_STATUSES.has(newStatus)) {
      await this.webhookDeliveryService.enqueueForTransaction(
        transaction,
        newStatus,
      );
    }
  }
}
