import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  In,
  IsNull,
  LessThan,
  QueryDeepPartialEntity,
  Repository,
} from 'typeorm';
import { WebhookDeliveryService } from '../../payments/infrastructure/webhooks/webhook-delivery.service';
import { stampCheckedAt } from '../../shared/persistence/rotation-stamp.util';
import { CardCapability } from '../domain/card-capability.enum';
import { CardEventSource } from '../domain/card-event-source.enum';
import { CardOperationOutcome } from '../domain/card-issuer.port';
import {
  CARD_STATUS_BY_LIFECYCLE_OPERATION,
  OPERABLE_CARD_STATUSES,
} from '../domain/card-lifecycle-operation.enum';
import {
  CardOperationStatus,
  IN_FLIGHT_CARD_OPERATION_STATUSES,
  OUTSTANDING_CARD_OPERATION_STATUSES,
} from '../domain/card-operation-status.enum';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { announceCardStatus } from './announce-card-status';
import {
  CardCallbackResolution,
  providerReportsOutcome,
} from './card-callback-resolution';
import { CardEventEntity } from '../infrastructure/persistence/card-event.entity';
import {
  CARD_OPERATION_MESSAGE_MAX_LENGTH,
  CARD_OPERATION_REASON_CODE_MAX_LENGTH,
  CardOperationEntity,
} from '../infrastructure/persistence/card-operation.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';

/** Every column a pass reads, named so the query stays narrow. */
const OPERATION_COLUMNS = {
  id: true,
  cardId: true,
  providerKey: true,
  requestReference: true,
  operationType: true,
  status: true,
  createdAt: true,
} as const;

/** Every column a pass reads from `card`, for the same reason. */
const CARD_COLUMNS = {
  id: true,
  publicId: true,
  partnerId: true,
  providerCardId: true,
  status: true,
} as const;

/** What one operation's examination produced, for the tally the pass logs. */
type Observation = 'applied' | 'failed' | 'unchanged' | 'unresolved';

/**
 * An outcome that actually carries a result — everything except the two arms
 * meaning "ask again".
 */
type ResolvedCardOperationOutcome = Exclude<
  CardOperationOutcome,
  { state: 'PENDING' } | { state: 'UNKNOWN_REFERENCE' }
>;

/** What the write transaction managed. Tagged, never discriminated by shape. */
type WriteResult =
  /** Somebody else moved the operation while this pass was reading it. */
  | { kind: 'operation-lost' }
  /** The operation was recorded; the card was left where it was. */
  | { kind: 'card-unchanged' }
  /** The operation was recorded; something else moved the card meanwhile. */
  | { kind: 'card-lost' }
  /** The operation was recorded and the card moved with it. */
  | { kind: 'card-moved'; movedTo: CardStatus };

/**
 * Turns a lifecycle operation an issuer acknowledged into the card's status, by
 * asking what became of it. Nothing announces that moment.
 */
@Injectable()
export class ResolveCardOperationsUseCase {
  private readonly logger = new Logger(ResolveCardOperationsUseCase.name);

  constructor(
    @InjectRepository(CardOperationEntity)
    private readonly operationRepository: Repository<CardOperationEntity>,
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
    private readonly webhookDeliveryService: WebhookDeliveryService,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  async execute(): Promise<void> {
    try {
      await this.resolveOutstanding();
    } catch (error) {
      // Contained, never propagated: escalation below is the only thing that
      // ever sees an operation stranded before its issuer call, and a failure
      // here is outside the per-row isolation.
      this.logger.error(
        `Card operation lookups failed for this pass: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await this.escalateStale();
  }

  /** Asks the issuer what became of every operation still worth asking about. */
  private async resolveOutstanding(): Promise<void> {
    // Filtered by capability in the query, never in the loop: a row no provider
    // can answer for still spends the batch, and once such rows outnumber it
    // the pass stops reaching the ones it exists to resolve.
    const providerKeys = this.cardIssuerRegistry.keysWithCapability(
      CardCapability.OPERATION_RESULT,
    );
    if (providerKeys.length === 0) return;

    // Counted as well as taken, so a saturated rotation is visible.
    const [operations, waiting] = await this.operationRepository.findAndCount({
      where: {
        // Derived, so a status added later is polled by default. **`DRAFT` is
        // deliberately outside it** — that row holds its card, but no reference
        // ever reached the issuer to ask about; escalation is what sees those.
        status: In([...OUTSTANDING_CARD_OPERATION_STATUSES]),
        providerKey: In(providerKeys),
      },
      select: OPERATION_COLUMNS,
      // Least-recently-checked first, the id only breaking a tie within a
      // batch. A row never checked sorts first, nulls ordering ahead here.
      order: { statusCheckedAt: 'ASC', id: 'ASC' },
      take: this.batchSize(),
    });

    if (operations.length === 0) return;

    await this.stamp(operations);

    const cardsById = await this.loadCards(operations);

    const tally = {
      applied: 0,
      failed: 0,
      unchanged: 0,
      unresolved: 0,
      errored: 0,
    };

    for (const operation of operations) {
      const card = cardsById.get(operation.cardId);
      if (!card?.providerCardId) {
        // Unreachable through the request path, which refuses such a card.
        tally.errored += 1;
        this.logger.warn(
          `Card operation ${operation.operationType} ${operation.requestReference} (${operation.providerKey}) points at a card with no issuer card id — nothing to look its outcome up by`,
        );
        continue;
      }

      try {
        tally[
          await this.observeOne(
            operation,
            card,
            card.providerCardId,
            CardEventSource.RECONCILE,
          )
        ] += 1;
      } catch (error) {
        // One row's failure never aborts the pass. It keeps its stamp and
        // rotates to the back rather than holding the head of the queue.
        tally.errored += 1;
        this.logger.warn(
          `Could not read the outcome of the ${operation.operationType} on card ${card.publicId} (${operation.providerKey}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.logger.log(
      `Card operation sweep examined ${operations.length} of ${waiting} outstanding: ${tally.applied} applied, ` +
        `${tally.failed} failed, ${tally.unchanged} unchanged, ${tally.unresolved} not answered for, ` +
        `${tally.errored} errored`,
    );
  }

  /**
   * Resolves the one operation an issuer has just named, for a caller that
   * learned of an outcome instead of waiting for the rotation.
   *
   * **The outcome the caller was told is never read here.** An issuer pushes a
   * fresh event per transition with no ordering guarantee, so a stale state
   * arrives after a fresher one and would walk the row backwards.
   */
  async resolveOneByRequestReference(
    providerKey: CardProviderKey,
    requestReference: string,
    source: CardEventSource,
  ): Promise<CardCallbackResolution> {
    if (
      !providerReportsOutcome(
        this.cardIssuerRegistry,
        CardCapability.OPERATION_RESULT,
        providerKey,
      )
    ) {
      return 'NO_ROW';
    }

    const operation = await this.operationRepository.findOne({
      where: {
        status: In([...OUTSTANDING_CARD_OPERATION_STATUSES]),
        providerKey,
        requestReference,
      },
      select: OPERATION_COLUMNS,
    });

    if (operation === null) return 'NO_ROW';

    // Or the row keeps its old stamp and jumps every later rotation.
    await this.stamp([operation]);

    const card = (await this.loadCards([operation])).get(operation.cardId);
    if (!card?.providerCardId) {
      this.logger.warn(
        `Card operation ${operation.operationType} ${operation.requestReference} (${operation.providerKey}) points at a card with no issuer card id — nothing to look its outcome up by`,
      );
      return 'UNRESOLVABLE';
    }

    await this.observeOne(operation, card, card.providerCardId, source);
    return 'RESOLVED';
  }

  /**
   * Records that this pass **looked**, not that the look worked — one statement
   * for the whole batch, before any of it is examined. This set never drains on
   * its own, so a row the issuer will not answer for must rotate like any other.
   */
  private async stamp(
    operations: readonly CardOperationEntity[],
  ): Promise<void> {
    await stampCheckedAt(
      this.operationRepository,
      'card_operation',
      operations.map((operation) => operation.id),
    );
  }

  private async loadCards(
    operations: readonly CardOperationEntity[],
  ): Promise<Map<string, CardEntity>> {
    const cards = await this.cardRepository.find({
      where: { id: In(operations.map((operation) => operation.cardId)) },
      select: CARD_COLUMNS,
    });

    return new Map(cards.map((card) => [card.id, card]));
  }

  private async observeOne(
    operation: CardOperationEntity,
    card: CardEntity,
    providerCardId: string,
    source: CardEventSource,
  ): Promise<Observation> {
    const adapter = this.cardIssuerRegistry.resolve(operation.providerKey);

    const outcome = await adapter.getCardOperationResult(
      providerCardId,
      // Both read from the row, never rebuilt: an issuer's lookup can be keyed
      // on the reference **and** the operation, and a wrong either reads as no
      // outcome rather than as an error.
      operation.requestReference,
      operation.operationType,
      {},
    );

    if (outcome.state === 'UNKNOWN_REFERENCE') {
      // Left exactly as it was, deliberately.
      this.logger.warn(
        `Card provider "${operation.providerKey}" does not hold the ${operation.operationType} it previously accepted for card ${card.publicId} — leaving it to be asked about again`,
      );
      return 'unresolved';
    }

    if (outcome.state === 'PENDING') {
      // Nothing written: a pending answer carries no new fact, and writing it
      // would rewrite every outstanding row on every pass.
      return 'unchanged';
    }

    return this.recordOutcome(operation, card, outcome, source);
  }

  /** Writes the outcome, and moves the card only where `statusToWrite` says so. */
  private async recordOutcome(
    operation: CardOperationEntity,
    card: CardEntity,
    outcome: ResolvedCardOperationOutcome,
    source: CardEventSource,
  ): Promise<Observation> {
    const previousStatus = operation.status;
    const status =
      outcome.state === 'APPLIED'
        ? CardOperationStatus.APPLIED
        : CardOperationStatus.FAILED;

    const move = this.statusToWrite(operation, card, outcome);

    const { reasonCode, message } = this.failureReason(operation, outcome);

    const written = await this.dataSource.transaction<WriteResult>(
      async (manager) => {
        // Conditional on the status this pass read: the request path is a
        // writer too, and a live call sits between that read and this write.
        const recorded = await manager
          .getRepository(CardOperationEntity)
          .update(
            { id: operation.id, status: previousStatus },
            {
              status,
              reasonCode,
              message,
              // The lookup's answer replaces the acknowledgement, which carries
              // no outcome at all.
              responsePayload: outcome.rawPayload as QueryDeepPartialEntity<
                Record<string, unknown>
              >,
            },
          );

        if (recorded.affected === 0) return { kind: 'operation-lost' };
        if (move === null) return { kind: 'card-unchanged' };

        const moved = await manager
          .getRepository(CardEntity)
          .update({ id: card.id, status: card.status }, { status: move });

        // The operation's write still stands: the issuer did carry it out,
        // whatever else moved the card since.
        if (moved.affected === 0) return { kind: 'card-lost' };

        const events = manager.getRepository(CardEventEntity);
        await events.save(
          events.create({
            cardId: card.id,
            fromStatus: card.status,
            toStatus: move,
            // The issuer moved this card, not a member of staff. How we came
            // to know is what `source` carries.
            source,
            detail: null,
          }),
        );

        return { kind: 'card-moved', movedTo: move };
      },
    );

    if (written.kind === 'operation-lost') {
      this.logger.warn(
        `Card operation ${operation.operationType} on card ${card.publicId} moved out of ${previousStatus} while this pass was reading it — leaving whatever changed it to report the change`,
      );
      return 'unresolved';
    }

    if (written.kind === 'card-lost') {
      this.logger.warn(
        `Card ${card.publicId} was changed by something else while its ${operation.operationType} was being reconciled — the operation is recorded ${status}, and the card is left to whatever moved it`,
      );
    }

    if (outcome.state === 'FAILED') {
      await this.announceFailure(operation, card, reasonCode, message);
      return 'failed';
    }

    if (written.kind === 'card-moved') {
      await announceCardStatus(
        this.webhookDeliveryService,
        this.logger,
        card,
        written.movedTo,
      );
    }

    return 'applied';
  }

  /**
   * Where this outcome leaves the card, or null to leave it alone.
   *
   * **A card outside the operable statuses is never moved back into them, and
   * the compare-and-set below does not cover this.** That keys on the status
   * this pass read, not the one the request was made against — so a card closed
   * during the issuer's own hours or days matches itself and an unguarded write
   * would take it back out of a terminal state.
   */
  private statusToWrite(
    operation: CardOperationEntity,
    card: CardEntity,
    outcome: ResolvedCardOperationOutcome,
  ): CardStatus | null {
    // A failure never moved the card.
    if (outcome.state !== 'APPLIED') return null;

    const target = CARD_STATUS_BY_LIFECYCLE_OPERATION[operation.operationType];
    // An operation that moves no status, or a card already there: the event and
    // the notification describe a transition, never a state.
    if (target === undefined || target === card.status) return null;

    if (!OPERABLE_CARD_STATUSES.includes(card.status)) {
      this.logger.warn(
        `Card ${card.publicId} is ${card.status}, which no lifecycle operation acts on — recording the ${operation.operationType} the provider carried out and leaving the card where it is`,
      );
      return null;
    }

    return target;
  }

  /** The issuer's words for a failure, or ours, cut to the columns holding them. */
  private failureReason(
    operation: CardOperationEntity,
    outcome: ResolvedCardOperationOutcome,
  ): { reasonCode: string | null; message: string | null } {
    if (outcome.state !== 'FAILED') {
      return { reasonCode: null, message: null };
    }

    // Trimmed to nothing counts as nothing: an issuer whose empty value is `""`
    // rather than an absent key would otherwise store a blank, and the card
    // read would publish a failed operation with no explanation at all.
    const reasonCode = outcome.reasonCode?.trim();
    const reason = outcome.reason?.trim();

    return {
      reasonCode: reasonCode
        ? reasonCode.slice(0, CARD_OPERATION_REASON_CODE_MAX_LENGTH)
        : null,
      // **Composed where an issuer reports nothing**, which is the usual case
      // and the only thing a partner is told when a freeze the issuer placed
      // itself cannot be lifted — that fails the same silent way.
      message: (
        reason ||
        `The card provider did not carry out this ${operation.operationType} and gave no reason`
      ).slice(0, CARD_OPERATION_MESSAGE_MAX_LENGTH),
    };
  }

  /**
   * Warns about an operation the issuer has not answered for in far longer than
   * it is given, stamping each once so the warning is not repeated per pass.
   *
   * **It never changes a status** — the horizon passing is no more evidence of
   * an outcome than a code the mapper could not read.
   *
   * It selects the operations **holding** a card rather than the ones being
   * polled, which is wider: a row stranded before its issuer call is one
   * nothing else will ever look at, and it holds its card until an operator
   * clears it.
   */
  private async escalateStale(): Promise<void> {
    const olderThan = new Date(
      Date.now() - this.escalationAfterSeconds() * 1000,
    );

    const stale = await this.operationRepository.find({
      where: {
        status: In([...IN_FLIGHT_CARD_OPERATION_STATUSES]),
        escalatedAt: IsNull(),
        createdAt: LessThan(olderThan),
      },
      select: OPERATION_COLUMNS,
      // `Using filesort`: no index serves this ordering — one leads with
      // `status`, the other with `card_id`. Bounded anyway, one row per card
      // being in flight at a time.
      order: { createdAt: 'ASC', id: 'ASC' },
      take: this.batchSize(),
    });

    if (stale.length === 0) return;

    const cardsById = await this.loadCards(stale);
    const now = Date.now();

    for (const operation of stale) {
      // One row at a time, because a batch write reports only how many rows
      // moved — and the warning below has to describe what this pass claimed.
      const written = await this.operationRepository.update(
        // The null check is repeated from the selection, so an operation is
        // escalated once however many passes reach it together.
        { id: operation.id, escalatedAt: IsNull() },
        { escalatedAt: new Date() },
      );

      if (written.affected === 0) continue;

      const card = cardsById.get(operation.cardId);
      const hours = Math.round(
        (now - operation.createdAt.getTime()) / 3_600_000,
      );

      this.logger.warn(
        `Card operation ${operation.operationType} ${operation.requestReference} on card ${
          card?.publicId ?? 'no longer in the table'
        } has been ${operation.status} at ${operation.providerKey} for ${hours}h with no outcome — it holds the card against any further operation and needs somebody to take it up with the provider`,
      );
    }
  }

  /**
   * Tells the partner an operation failed. **Not `card.status_updated`** — the
   * card never moved, and announcing a change that did not happen is worse than
   * the silence this event exists to end.
   */
  private async announceFailure(
    operation: CardOperationEntity,
    card: CardEntity,
    reasonCode: string | null,
    reason: string | null,
  ): Promise<void> {
    try {
      await this.webhookDeliveryService.enqueueForCard(
        card.id,
        card.partnerId,
        'card_operation.failed',
        {
          eventType: 'card_operation.failed',
          cardPublicId: card.publicId,
          operation: operation.operationType,
          status: CardOperationStatus.FAILED,
          // No reference: an operation is not addressable.
          reasonCode,
          reason,
          occurredAt: new Date().toISOString(),
        },
      );
    } catch (error) {
      this.logger.error(
        `Card operation ${operation.operationType} on card ${card.publicId} failed and the partner could not be notified: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** How many operations one pass may examine. Each is a live call. */
  private batchSize(): number {
    return this.configService.getOrThrow<number>(
      'CARD_OPERATION_SWEEP_BATCH_SIZE',
    );
  }

  /** How long an operation may go unanswered before it is worth a warning. */
  private escalationAfterSeconds(): number {
    return this.configService.getOrThrow<number>(
      'CARD_OPERATION_ESCALATION_AFTER_SECONDS',
    );
  }
}
