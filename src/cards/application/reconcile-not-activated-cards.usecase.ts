import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  FindOptionsWhere,
  In,
  IsNull,
  Not,
  QueryDeepPartialEntity,
  Repository,
} from 'typeorm';
import { WebhookDeliveryService } from '../../payments/infrastructure/webhooks/webhook-delivery.service';
import { truncatedOrNull } from '../../shared/persistence/column-text.util';
import { stampCheckedAt } from '../../shared/persistence/rotation-stamp.util';
import { CardActivationStatus } from '../domain/card-activation-status.enum';
import { CardCapability } from '../domain/card-capability.enum';
import { CardApplicationOutcome } from '../domain/card-issuer.port';
import { CardEventSource } from '../domain/card-event-source.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { activationColumnsFor } from './card-activation-columns';
import {
  CARD_APPLICATION_MESSAGE_MAX_LENGTH,
  CARD_APPLICATION_REASON_CODE_MAX_LENGTH,
  CardApplicationEntity,
} from '../infrastructure/persistence/card-application.entity';
import {
  CARD_EVENT_DETAIL_MAX_LENGTH,
  CardEventEntity,
} from '../infrastructure/persistence/card-event.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';

/**
 * Every column a pass reads from `card`, named so the query stays narrow. The
 * loaded entity is therefore partial, so every write below goes through
 * `update` rather than `save`.
 */
const CARD_COLUMNS = {
  id: true,
  publicId: true,
  partnerId: true,
  providerKey: true,
  providerCardId: true,
  status: true,
  maskedPan: true,
  activationStatus: true,
  activationReasonCode: true,
  activationReason: true,
} as const;

/** Every column a pass reads from `card_application`, for the same reason. */
const APPLICATION_COLUMNS = {
  id: true,
  cardId: true,
  requestId: true,
  reasonCode: true,
  message: true,
} as const;

/** What one card's examination produced, for the tally the pass logs. */
type Observation = 'activated' | 'changed' | 'unchanged' | 'unresolved';

/**
 * Watches a card an issuer has opened travel the rest of the way to usable.
 * Nothing tells us when that happens.
 */
@Injectable()
export class ReconcileNotActivatedCardsUseCase {
  private readonly logger = new Logger(ReconcileNotActivatedCardsUseCase.name);

  constructor(
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    @InjectRepository(CardApplicationEntity)
    private readonly applicationRepository: Repository<CardApplicationEntity>,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
    private readonly webhookDeliveryService: WebhookDeliveryService,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  async execute(): Promise<void> {
    // The same capability the lookup is gated by, applied in the query rather
    // than in the loop: a row belonging to a provider that can never answer is
    // work that will never be done, and skipping it after loading still spends
    // the batch on it.
    const providerKeys = this.cardIssuerRegistry.keysWithCapability(
      CardCapability.APPLICATION_RESULT,
    );
    if (providerKeys.length === 0) return;

    const waitingFor: FindOptionsWhere<CardEntity> = {
      status: CardStatus.NOT_ACTIVATED,
      providerKey: In(providerKeys),
      // A card without one was never opened at the issuer — the issuance call
      // failed, or its result has not landed yet. Either way the result sweep
      // owns it and there is no card for this pass to ask about.
      providerCardId: Not(IsNull()),
    };
    // Least-recently-checked first, with the id only as a tie-break among
    // cards stamped in the same batch. A card never checked sorts first,
    // MariaDB ordering nulls ahead of values on an ascending sort.
    const rotationOrder = { statusCheckedAt: 'ASC', id: 'ASC' } as const;
    const batchSize = this.batchSize();

    // Cards with an activation outstanding first: this set never drains — no
    // issuer moves a card to usable unprompted — so the rotation alone makes
    // the lag on a just-activated card grow with the cards nobody is waiting
    // on.
    const outstanding = await this.cardRepository.find({
      where: { ...waitingFor, activationStatus: CardActivationStatus.PENDING },
      select: CARD_COLUMNS,
      order: rotationOrder,
      take: batchSize,
    });

    // Counted as well as taken, so a saturated rotation is visible. Still
    // every card: an issuer can publish a masked number or a fault long after
    // opening one.
    const [rotation, waiting] = await this.cardRepository.findAndCount({
      where: waitingFor,
      select: CARD_COLUMNS,
      order: rotationOrder,
      take: batchSize,
    });

    const alreadyTaken = new Set(outstanding.map((card) => card.id));
    const cards = [
      ...outstanding,
      ...rotation
        .filter((card) => !alreadyTaken.has(card.id))
        .slice(0, batchSize - outstanding.length),
    ];

    if (cards.length === 0) return;

    await this.stamp(cards);

    const applicationsByCardId = await this.loadApplications(cards);

    const tally = {
      activated: 0,
      changed: 0,
      unchanged: 0,
      unresolved: 0,
      failed: 0,
    };

    for (const card of cards) {
      const application = applicationsByCardId.get(card.id);
      if (!application) {
        // The issuance path writes one for every provider, so this is a card
        // opened by something that did not go through it. There is no reference
        // to ask by, and inventing one would query a stranger's application.
        tally.failed += 1;
        this.logger.warn(
          `Card ${card.publicId} (${card.providerKey}) has a provider card id and no application row — nothing to look its status up by`,
        );
        continue;
      }

      try {
        tally[await this.observeOne(card, application)] += 1;
      } catch (error) {
        // One card's failure must never abort the pass for the rest — the same
        // per-item isolation the result sweep and both reconciles use. The row
        // is left exactly as it was apart from its stamp, so the next pass
        // retries it once the rest of the queue has had its turn.
        tally.failed += 1;
        this.logger.warn(
          `Could not read the status of card ${card.publicId} (${card.providerKey}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.logger.log(
      `Card status sweep examined ${cards.length} of ${waiting} waiting: ${tally.activated} activated, ` +
        `${tally.changed} otherwise updated, ${tally.unchanged} unchanged, ${tally.unresolved} not answered for, ` +
        `${tally.failed} failed`,
    );
  }

  /**
   * Records that this pass looked at these cards. One statement for the whole
   * batch, written before any of them is examined, and whatever the
   * examination then does.
   */
  private async stamp(cards: readonly CardEntity[]): Promise<void> {
    await stampCheckedAt(
      this.cardRepository,
      'card',
      cards.map((card) => card.id),
    );
  }

  private async loadApplications(
    cards: readonly CardEntity[],
  ): Promise<Map<string, CardApplicationEntity>> {
    const applications = await this.applicationRepository.find({
      where: { cardId: In(cards.map((card) => card.id)) },
      select: APPLICATION_COLUMNS,
    });

    return new Map(
      applications.map((application) => [application.cardId, application]),
    );
  }

  private async observeOne(
    card: CardEntity,
    application: CardApplicationEntity,
  ): Promise<Observation> {
    // No capability check: the query above only returned cards belonging to a
    // provider that declares the flag, and a second check here would be
    // unreachable — as well as inviting a later reader to treat the filter as
    // optional, which is the thing that makes the batch starve.
    const adapter = this.cardIssuerRegistry.resolve(card.providerKey);

    const outcome = await adapter.getCardApplicationResult(
      // Read from the row, never rebuilt from the card: an adapter's wire form
      // is derived from this exact value.
      application.requestId,
      {},
    );

    if (outcome.state !== 'ISSUED') {
      // The issuer previously named a card against this reference and is no
      // longer doing so. Nothing is written on that: the card row is our
      // evidence they opened one, and discarding it on an answer that
      // contradicts an earlier answer resolves the disagreement by guess.
      this.logger.warn(
        `Card provider "${card.providerKey}" no longer reports a card for application ${application.requestId}, which produced card ${card.publicId} — leaving it to be asked again`,
      );
      return 'unresolved';
    }

    if (outcome.providerCardId !== card.providerCardId) {
      // Their answer names a different card than the one this reference
      // produced. Writing a status read off some other card is worse than
      // writing nothing, and it is not a disagreement this pass can settle.
      this.logger.warn(
        `Card provider "${card.providerKey}" reports card "${outcome.providerCardId}" for application ${application.requestId}, but card ${card.publicId} holds "${card.providerCardId}" — leaving both alone`,
      );
      return 'unresolved';
    }

    return this.recordObservation(card, application, outcome);
  }

  /**
   * Persists whatever the answer actually changed, and nothing it did not. A
   * pass that found nothing new writes nothing.
   */
  private async recordObservation(
    card: CardEntity,
    application: CardApplicationEntity,
    outcome: Extract<CardApplicationOutcome, { state: 'ISSUED' }>,
  ): Promise<Observation> {
    const previousStatus = card.status;
    const statusChanged = outcome.status !== previousStatus;

    // Filled in when it arrives and never blanked. This issuer has been seen
    // sending its card id before its card number, so an absent one means "not
    // sent this time" rather than "this card has none" — and overwriting a
    // stored number with nothing would lose the only copy of it.
    const maskedPan = outcome.maskedPan ?? null;
    const maskedPanArrived = maskedPan !== null && maskedPan !== card.maskedPan;

    // A card the issuer reports as usable carries no current fault, whatever
    // their payload still says.
    const usable = outcome.status === CardStatus.ACTIVE;
    const reasonCode = usable
      ? null
      : truncatedOrNull(
          outcome.reasonCode,
          CARD_APPLICATION_REASON_CODE_MAX_LENGTH,
        );
    const reason = usable
      ? null
      : truncatedOrNull(outcome.reason, CARD_APPLICATION_MESSAGE_MAX_LENGTH);
    const reasonChanged =
      reasonCode !== application.reasonCode || reason !== application.message;

    // The outcome itself, so the status and the activation provably come off
    // one answer rather than being paired by this call site.
    const activation = activationColumnsFor(outcome, reasonCode, reason);
    const activationChanged =
      activation !== null &&
      (activation.activationStatus !== card.activationStatus ||
        activation.activationReasonCode !== card.activationReasonCode ||
        activation.activationReason !== card.activationReason);

    if (
      !statusChanged &&
      !maskedPanArrived &&
      !reasonChanged &&
      !activationChanged
    ) {
      return 'unchanged';
    }

    if (reasonChanged && reasonCode !== null) {
      // Warned once, on the pass that first sees it. The comparison above is
      // what makes that "once" rather than "every tick until somebody acts" —
      // this pass only observes, so an unchanged fault is not news, and there
      // is nothing here to retry.
      this.logger.warn(
        `Card provider "${card.providerKey}" reports card ${card.publicId} is not usable: ${reasonCode}${
          reason ? ` — ${reason}` : ''
        }`,
      );
    }

    const applied = await this.dataSource.transaction(async (manager) => {
      if (statusChanged || maskedPanArrived || activationChanged) {
        const changes: QueryDeepPartialEntity<CardEntity> = {
          ...(statusChanged && { status: outcome.status }),
          ...(maskedPanArrived && { maskedPan }),
          ...(activationChanged && activation),
        };

        // Conditional on the status this pass actually read, which makes the
        // write safe against anything that moved the card since the batch was
        // loaded.
        const written = await manager
          .getRepository(CardEntity)
          .update({ id: card.id, status: previousStatus }, changes);

        if (written.affected === 0) return false;
      }

      if (statusChanged) {
        const events = manager.getRepository(CardEventEntity);
        await events.save(
          events.create({
            cardId: card.id,
            fromStatus: previousStatus,
            toStatus: outcome.status,
            source: CardEventSource.RECONCILE,
            // The issuer's own words for why, where they gave any — which is
            // most of the value of a transition into a state a partner did not
            // ask for.
            detail: this.composeDetail(reasonCode, reason),
          }),
        );
      }

      if (statusChanged || reasonChanged) {
        await manager.getRepository(CardApplicationEntity).update(
          application.id,
          // Written as an explicit null rather than left undefined when the
          // issuer reports no fault: TypeORM skips an undefined column, so a
          // reason that has cleared would otherwise stay on the row for ever.
          {
            reasonCode,
            message: reason,
            responsePayload: outcome.rawPayload,
          } as QueryDeepPartialEntity<CardApplicationEntity>,
        );
      }
      return true;
    });

    if (!applied) {
      this.logger.warn(
        `Card ${card.publicId} moved out of ${previousStatus} while this pass was reading it — leaving whatever changed it to report the change`,
      );
      return 'unresolved';
    }

    // Everything past the early return above wrote something, so a pass that
    // moved no status still reports work done. The card was selected as not
    // activated, so any move to active is a transition by construction —
    // there is no already-active case to guard.
    if (!statusChanged || !usable) return 'changed';

    // Enqueued after the commit, matching the activation route.
    await this.webhookDeliveryService.enqueueForCard(
      card.id,
      card.partnerId,
      'card.activated',
      {
        eventType: 'card.activated',
        cardPublicId: card.publicId,
        status: outcome.status,
        occurredAt: new Date().toISOString(),
      },
    );

    return 'activated';
  }

  private composeDetail(
    reasonCode: string | null,
    reason: string | null,
  ): string | null {
    const detail =
      reasonCode && reason
        ? `${reasonCode}: ${reason}`
        : (reason ?? reasonCode);

    return detail?.slice(0, CARD_EVENT_DETAIL_MAX_LENGTH) ?? null;
  }

  /**
   * How many cards one pass may examine. Shared with the result sweep it runs
   * beside, because both bound the same thing for the same reason — a live
   * call per row.
   */
  private batchSize(): number {
    return this.configService.getOrThrow<number>(
      'CARD_APPLICATION_SWEEP_BATCH_SIZE',
    );
  }
}
