import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  In,
  QueryDeepPartialEntity,
  Repository,
} from 'typeorm';
import { WebhookDeliveryService } from '../../payments/infrastructure/webhooks/webhook-delivery.service';
import { stampCheckedAt } from '../../shared/persistence/rotation-stamp.util';
import { CardApplicationStatus } from '../domain/card-application-status.enum';
import { CardCapability } from '../domain/card-capability.enum';
import { CardApplicationOutcome } from '../domain/card-issuer.port';
import { CardEventSource } from '../domain/card-event-source.enum';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import {
  CardCallbackResolution,
  providerReportsOutcome,
} from './card-callback-resolution';
import {
  CARD_APPLICATION_MESSAGE_MAX_LENGTH,
  CARD_APPLICATION_REASON_CODE_MAX_LENGTH,
  CardApplicationEntity,
} from '../infrastructure/persistence/card-application.entity';
import { CardEventEntity } from '../infrastructure/persistence/card-event.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';

/**
 * Every column a pass reads, named so the query stays narrow.
 * `response_payload` is the point: it is the largest column on the row and
 * this path only ever *writes* it.
 */
const PENDING_COLUMNS = {
  id: true,
  cardId: true,
  providerKey: true,
  requestId: true,
} as const;

/**
 * Turns applications an issuer has acknowledged into cards, by asking what
 * became of them. Only an issuer that opens cards asynchronously has anything
 * to answer, and the query says so rather than the loop.
 */
@Injectable()
export class ResolveCardApplicationsUseCase {
  private readonly logger = new Logger(ResolveCardApplicationsUseCase.name);

  constructor(
    @InjectRepository(CardApplicationEntity)
    private readonly applicationRepository: Repository<CardApplicationEntity>,
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    @InjectRepository(CardEventEntity)
    private readonly eventRepository: Repository<CardEventEntity>,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
    private readonly webhookDeliveryService: WebhookDeliveryService,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  async execute(): Promise<void> {
    const providerKeys = this.cardIssuerRegistry.keysWithCapability(
      CardCapability.APPLICATION_RESULT,
    );
    // No issuer on this deployment reports an outcome separately, so there is
    // no work here at all — and nothing to query for.
    if (providerKeys.length === 0) return;

    const pending = await this.applicationRepository.find({
      where: {
        status: CardApplicationStatus.SUBMITTED,
        providerKey: In(providerKeys),
      },
      select: PENDING_COLUMNS,
      // Least-recently-asked first; the id only breaks ties within a batch.
      // Never order by id alone here: a PENDING answer writes nothing, so an
      // application the issuer never resolves would hold the head of the queue
      // for ever. A never-asked row is null and sorts first — the same trade
      // every pass here makes.
      order: { statusCheckedAt: 'ASC', id: 'ASC' },
      take: this.batchSize(),
    });

    if (pending.length === 0) return;

    await this.stamp(pending);

    const tally = {
      issued: 0,
      rejected: 0,
      pending: 0,
      unknown: 0,
      failed: 0,
    };

    for (const application of pending) {
      try {
        const outcome = await this.resolveOne(
          application,
          CardEventSource.RECONCILE,
        );
        tally[outcome] += 1;
      } catch (error) {
        // One application's failure must never abort the pass for the rest —
        // the same per-item isolation the cardholder and balance reconciles
        // use. A provider outage is the ordinary reason this fires, and the
        // row is left exactly as it was, so the next pass retries it.
        tally.failed += 1;
        this.logger.warn(
          `Could not resolve card application ${application.requestId} (${application.providerKey}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.logger.log(
      `Card application sweep examined ${pending.length}: ${tally.issued} issued, ${tally.rejected} rejected, ` +
        `${tally.pending} still pending, ${tally.unknown} not held by the issuer, ${tally.failed} failed`,
    );
  }

  /**
   * Resolves the one application an issuer has just named, for a caller that
   * learned of an outcome instead of waiting for the rotation.
   *
   * **The pass's own predicate**, narrowed to one reference — restating it
   * would be a second place for the two to drift.
   */
  async resolveOneByRequestId(
    providerKey: CardProviderKey,
    requestId: string,
    source: CardEventSource,
  ): Promise<CardCallbackResolution> {
    if (
      !providerReportsOutcome(
        this.cardIssuerRegistry,
        CardCapability.APPLICATION_RESULT,
        providerKey,
      )
    ) {
      return 'NO_ROW';
    }

    const application = await this.applicationRepository.findOne({
      where: {
        status: CardApplicationStatus.SUBMITTED,
        providerKey,
        requestId,
      },
      select: PENDING_COLUMNS,
    });

    if (application === null) return 'NO_ROW';

    // Or the row keeps its old stamp and sorts to the head of every later
    // rotation.
    await this.stamp([application]);
    await this.resolveOne(application, source);
    return 'RESOLVED';
  }

  /**
   * Records that this pass asked, before any row is examined and whatever the
   * examination then does — a row the issuer failed to answer for has still
   * had its turn.
   */
  private async stamp(
    applications: readonly CardApplicationEntity[],
  ): Promise<void> {
    await stampCheckedAt(
      this.applicationRepository,
      'card_application',
      applications.map((application) => application.id),
    );
  }

  private async resolveOne(
    application: CardApplicationEntity,
    source: CardEventSource,
  ): Promise<'issued' | 'rejected' | 'pending' | 'unknown'> {
    // No capability check here: both callers select only rows belonging to a
    // provider that declares the flag, so a third check would be unreachable —
    // and having one invites a later reader to treat the filter as optional,
    // which is the thing that makes the batch starve.
    const adapter = this.cardIssuerRegistry.resolve(application.providerKey);

    // Read from the row, never rebuilt from the card: this is the reference the
    // attempt was recorded under, and an adapter's wire form is derived from
    // this exact value.
    const outcome = await adapter.getCardApplicationResult(
      application.requestId,
      {},
    );

    switch (outcome.state) {
      case 'ISSUED':
        await this.recordIssued(application, outcome, source);
        return 'issued';

      case 'REJECTED':
        await this.recordRejected(application, outcome);
        return 'rejected';

      case 'UNKNOWN_REFERENCE':
        // Left exactly as it was, deliberately.
        this.logger.warn(
          `Card provider "${application.providerKey}" does not hold card application ${application.requestId}, which it previously acknowledged — leaving it to be asked again`,
        );
        return 'unknown';

      case 'PENDING':
        // Nothing written on purpose: a pending answer carries no new fact, and
        // writing it would rewrite every in-flight row on every pass.
        return 'pending';
    }
  }

  /**
   * The issuer opened a card. `provider_card_id` is what makes the card usable
   * — every later call is keyed on it.
   */
  private async recordIssued(
    application: CardApplicationEntity,
    outcome: Extract<CardApplicationOutcome, { state: 'ISSUED' }>,
    source: CardEventSource,
  ): Promise<void> {
    const activated = await this.dataSource.transaction(async (manager) => {
      const card = await manager.getRepository(CardEntity).findOne({
        where: { id: application.cardId },
      });

      if (!card) {
        // The foreign key makes this unreachable while the row exists, and no
        // code path deletes a card. Recorded rather than assumed away: silently
        // approving an application whose card has gone would lose the id the
        // issuer just gave us.
        throw new Error(
          `Card application ${application.requestId} points at card ${application.cardId}, which does not exist`,
        );
      }

      const alreadyResolved =
        card.providerCardId === outcome.providerCardId &&
        card.status === outcome.status;

      let becameUsable = false;

      if (!alreadyResolved) {
        const previousStatus = card.status;
        becameUsable =
          previousStatus !== CardStatus.ACTIVE &&
          outcome.status === CardStatus.ACTIVE;
        card.providerCardId = outcome.providerCardId;
        card.status = outcome.status;
        // Kept rather than overwritten when the outcome carries none.
        card.maskedPan = outcome.maskedPan ?? card.maskedPan;
        await manager.getRepository(CardEntity).save(card);

        const events = manager.getRepository(CardEventEntity);
        await events.save(
          events.create({
            cardId: card.id,
            fromStatus: previousStatus,
            toStatus: card.status,
            // How we came to know, not who acted.
            source,
          }),
        );
      }

      await this.markApplication(
        manager,
        application,
        CardApplicationStatus.APPROVED,
        null,
        null,
        outcome.rawPayload,
      );

      return becameUsable
        ? { id: card.id, partnerId: card.partnerId, publicId: card.publicId }
        : null;
    });

    if (!activated) return;

    // After the commit, matching every other path that enqueues this event.
    await this.webhookDeliveryService.enqueueForCard(
      activated.id,
      activated.partnerId,
      'card.activated',
      {
        eventType: 'card.activated',
        cardPublicId: activated.publicId,
        status: CardStatus.ACTIVE,
        occurredAt: new Date().toISOString(),
      },
    );
  }

  /** The issuer refused the application. The card row is left alone. */
  private async recordRejected(
    application: CardApplicationEntity,
    outcome: Extract<CardApplicationOutcome, { state: 'REJECTED' }>,
  ): Promise<void> {
    this.logger.warn(
      `Card provider "${application.providerKey}" refused card application ${application.requestId}` +
        (outcome.reasonCode ? ` (${outcome.reasonCode})` : '') +
        (outcome.reason ? `: ${outcome.reason}` : ''),
    );

    // A refusal touches this row and nothing else, so it needs no transaction
    // of its own — one statement is already atomic.
    await this.markApplication(
      this.applicationRepository.manager,
      application,
      CardApplicationStatus.REJECTED,
      outcome.reasonCode ?? null,
      outcome.reason ?? null,
      outcome.rawPayload,
    );
  }

  /**
   * `update`, not `save`. The rows this pass loads are a narrow projection,
   * and saving a partially-loaded entity is what would make that unsafe.
   */
  private async markApplication(
    manager: EntityManager,
    application: CardApplicationEntity,
    status: CardApplicationStatus,
    reasonCode: string | null,
    message: string | null,
    responsePayload: Record<string, unknown>,
  ): Promise<void> {
    // The cast is for the `json` column alone: TypeORM's deep-partial recurses
    // into object-typed columns, and an index-signature payload is not
    // assignable to the mapped form it produces. Every other field here is
    // checked normally.
    const changes = {
      status,
      reasonCode:
        reasonCode?.slice(0, CARD_APPLICATION_REASON_CODE_MAX_LENGTH) ?? null,
      message: message?.slice(0, CARD_APPLICATION_MESSAGE_MAX_LENGTH) ?? null,
      // The first thing with an outcome to store here: the acknowledgement this
      // row was written from carries a success code and nothing else, so the
      // lookup's answer is the only payload worth replaying.
      responsePayload,
    } satisfies Partial<CardApplicationEntity>;

    await manager
      .getRepository(CardApplicationEntity)
      .update(
        application.id,
        changes as QueryDeepPartialEntity<CardApplicationEntity>,
      );
  }

  /**
   * How many applications one pass may examine. Bounded because each is a live
   * call to an issuer, so an unbounded pass on a large backlog would overlap
   * the pass behind it.
   */
  private batchSize(): number {
    return this.configService.getOrThrow<number>(
      'CARD_APPLICATION_SWEEP_BATCH_SIZE',
    );
  }
}
