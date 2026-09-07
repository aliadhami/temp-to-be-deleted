import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { In, Repository } from 'typeorm';
import { WebhookDeliveryService } from '../../payments/infrastructure/webhooks/webhook-delivery.service';
import {
  isDuplicateEntryError,
  isTransactionRestartError,
} from '../../shared/persistence/duplicate-entry.util';
import { CardStatusUpdateResponseDto } from '../api/dto/card-status-update-response.dto';
import { CardActivationStatus } from '../domain/card-activation-status.enum';
import { CardCapability } from '../domain/card-capability.enum';
import { CardEventSource } from '../domain/card-event-source.enum';
import { CardBlockReason } from '../domain/card-issuer.port';
import {
  CARD_STATUS_BY_LIFECYCLE_OPERATION,
  CardLifecycleOperation,
  OPERABLE_CARD_STATUSES,
} from '../domain/card-lifecycle-operation.enum';
import {
  CardOperationStatus,
  IN_FLIGHT_CARD_OPERATION_STATUSES,
} from '../domain/card-operation-status.enum';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { CardProviderThrottledError } from '../domain/card-provider-throttled.error';
import { CardStatus } from '../domain/card-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardApplicationEntity } from '../infrastructure/persistence/card-application.entity';
import {
  CARD_OPERATION_IN_FLIGHT_INDEX,
  CARD_OPERATION_MESSAGE_MAX_LENGTH,
  CARD_OPERATION_REASON_CODE_MAX_LENGTH,
  CardOperationEntity,
} from '../infrastructure/persistence/card-operation.entity';
import { CardEventEntity } from '../infrastructure/persistence/card-event.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { announceCardStatus } from './announce-card-status';
import { assertCardCapability } from './assert-card-capability';
import { CardOperationAvailability } from './card-operation-availability';

/** The two statuses a lifecycle request can act on, in our vocabulary. */
const OPERATION_BY_STATUS = {
  on_hold: CardLifecycleOperation.BLOCK,
  active: CardLifecycleOperation.UNBLOCK,
} as const;

/**
 * The `reason_code` written when the attempt failed on our side of the wire.
 * Distinct from an issuer code so a reader can tell "they said no" from "we
 * never got there".
 */
const LOCAL_FAILURE_CODE = 'SUBMISSION_ERROR';

/** The original attempt plus four restarts. */
const MAX_WRITE_ATTEMPTS = 5;

/**
 * How long a restarted write waits, multiplied by the attempt number and
 * jittered, so racers rolled back together do not queue up in lockstep. Small
 * on purpose: this runs inline on a partner's request.
 */
const RESTART_BASE_DELAY_MS = 10;

/** Blocks and unblocks a card that already exists. */
@Injectable()
export class UpdateCardStatusUseCase {
  private readonly logger = new Logger(UpdateCardStatusUseCase.name);

  constructor(
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    @InjectRepository(CardEventEntity)
    private readonly cardEventRepository: Repository<CardEventEntity>,
    @InjectRepository(CardOperationEntity)
    private readonly operationRepository: Repository<CardOperationEntity>,
    @InjectRepository(CardApplicationEntity)
    private readonly applicationRepository: Repository<CardApplicationEntity>,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
    private readonly cardOperationAvailability: CardOperationAvailability,
    private readonly webhookDeliveryService: WebhookDeliveryService,
  ) {}

  async execute(
    partnerId: string,
    cardPublicId: string,
    status: 'active' | 'on_hold',
    reason: CardBlockReason | undefined,
  ): Promise<CardStatusUpdateResponseDto> {
    const card = await this.cardRepository.findOne({
      where: { publicId: cardPublicId, partnerId },
    });
    // Another partner's card is a 404 rather than a 403: the partner scoping is
    // in the query, so "not yours" and "does not exist" are deliberately
    // indistinguishable.
    if (!card || !card.providerCardId) {
      throw new NotFoundException('Card not found');
    }
    const providerCardId = card.providerCardId;
    const operation = OPERATION_BY_STATUS[status];

    const adapter = this.cardIssuerRegistry.resolve(card.providerKey);
    // Every gate below sits above the write, so a refused request cannot leave
    // an orphaned draft operation holding the card.
    assertCardCapability(
      adapter,
      CardCapability.BLOCK,
      card.providerKey,
      'blocking and unblocking a card',
    );

    if (!OPERABLE_CARD_STATUSES.includes(card.status)) {
      throw new ConflictException(
        `Card ${card.publicId} is ${card.status} — only an active or on-hold card can be blocked or unblocked`,
      );
    }

    // A card mid-activation is not one whose lifecycle a partner should be
    // steering, and refusing here is load-bearing rather than tidy: only the
    // not-activated reconcile clears the activation columns, and it selects on
    // the card's status. Letting this move the card out of that status would
    // strand `activationStatus` at PENDING for ever.
    if (card.activationStatus === CardActivationStatus.PENDING) {
      throw new ConflictException(
        `Card ${card.publicId} has an activation awaiting the provider — wait for its outcome before changing its status`,
      );
    }

    // Last of the gates, because it is the only one that costs a query: the
    // two above are settled from the card row already in hand, and a request
    // they refuse should not have paid for the reads here.
    await this.assertOperationAvailable(card, operation);

    const row = await this.writeDraft(card, operation);

    // **Below the draft**, whose unique index refuses a request racing an
    // operation in flight: until one lands the card reads its old status.
    // **And only where operations settle afterwards** — an issuer settling
    // during the call answers with the card's real status, which is worth the
    // call.
    if (
      card.status === CARD_STATUS_BY_LIFECYCLE_OPERATION[operation] &&
      adapter.capabilities.has(CardCapability.OPERATION_RESULT)
    ) {
      await this.operationRepository.update(
        { id: row.id },
        { status: CardOperationStatus.APPLIED },
      );

      return {
        publicId: card.publicId,
        operation,
        operationStatus: CardOperationStatus.APPLIED,
        cardStatus: card.status,
        updated: false,
      };
    }

    // **Only the call itself is inside the failure handler.** Everything after
    // it describes a request the issuer already holds.
    const result = await this.callProvider(row, card, () =>
      adapter.updateCardStatus(
        providerCardId,
        {
          // The row's own reference, which the issuer's result lookup answers
          // on. Whatever form the issuer wants it in is the adapter's business.
          reference: row.requestReference,
          status,
          ...(reason && { reason }),
        },
        {},
        // Not the reference: this is the transport-level replay key for an
        // issuer that takes one, and a card is blocked and unblocked
        // repeatedly, so a stable key would make the second block look like a
        // replay of the first.
        `status-${card.publicId}-${randomUUID()}`,
      ),
    );

    if (result.state === 'SUBMITTED') {
      // **Nothing about the card is written.** The issuer has taken the
      // request on and has not carried it out, so moving the status here would
      // tell a partner their card is blocked while it is still spendable. What
      // was asked for is readable on the card as its most recent operation.
      await this.operationRepository.update(
        { id: row.id },
        { status: CardOperationStatus.SUBMITTED },
      );

      return {
        publicId: card.publicId,
        operation,
        operationStatus: CardOperationStatus.SUBMITTED,
        cardStatus: card.status,
      };
    }

    await this.operationRepository.update(
      { id: row.id },
      { status: CardOperationStatus.APPLIED },
    );

    if (result.status === card.status) {
      return {
        publicId: card.publicId,
        operation,
        operationStatus: CardOperationStatus.APPLIED,
        cardStatus: result.status,
        updated: result.updated,
      };
    }

    const previousStatus = card.status;
    // A compare-and-set on the status this request read, because the sweeps
    // are writers too. **Zero rows means somebody else got there first**, and
    // the event and the webhook below must not then describe a transition this
    // request did not make.
    const written = await this.withRestart(`Card ${card.publicId}`, () =>
      this.cardRepository.update(
        { id: card.id, status: previousStatus },
        { status: result.status },
      ),
    );

    if (written.affected === 0) {
      this.logger.warn(
        `Card ${card.publicId} was changed by something else while its ${operation} was in flight — leaving whatever changed it to report the change`,
      );

      const current = await this.cardRepository.findOne({
        where: { id: card.id },
        select: { status: true },
      });

      return {
        publicId: card.publicId,
        operation,
        operationStatus: CardOperationStatus.APPLIED,
        cardStatus: current?.status ?? result.status,
        updated: false,
      };
    }

    card.status = result.status;
    await this.recordEvent(card, previousStatus, result.status, reason);
    await announceCardStatus(
      this.webhookDeliveryService,
      this.logger,
      card,
      result.status,
    );

    return {
      publicId: card.publicId,
      operation,
      operationStatus: CardOperationStatus.APPLIED,
      cardStatus: result.status,
      updated: result.updated,
    };
  }

  /**
   * Records the transition. Guarded rather than left to propagate: by this
   * point the issuer has applied the change and the card row has moved, so a
   * failure here must not cost the partner their notification as well.
   */
  private async recordEvent(
    card: CardEntity,
    fromStatus: CardStatus,
    toStatus: CardStatus,
    reason: CardBlockReason | undefined,
  ): Promise<void> {
    try {
      await this.withRestart(`The event for card ${card.publicId}`, () =>
        this.cardEventRepository.save(
          this.cardEventRepository.create({
            cardId: card.id,
            fromStatus,
            toStatus,
            source: CardEventSource.MANUAL,
            detail: reason ?? null,
          }),
        ),
      );
    } catch (error) {
      this.logger.error(
        `Card ${card.publicId} moved to ${toStatus} and the transition could not be recorded: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Runs one write, restarting it when the server rolled it back as a deadlock
   * victim — `card` and `card_event` have several writers. Each write is a
   * single statement that left nothing behind, so a restart repeats it rather
   * than doubling it. It never wraps the provider call above it.
   */
  private async withRestart<T>(
    what: string,
    write: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await write();
      } catch (error) {
        if (isTransactionRestartError(error) && attempt < MAX_WRITE_ATTEMPTS) {
          this.logger.warn(
            `${what} was rolled back by the server — restarting the write`,
          );
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.random() * RESTART_BASE_DELAY_MS * attempt,
            ),
          );
          continue;
        }

        throw error;
      }
    }
  }

  /**
   * Refuses an operation this card does not accept — through the same helper
   * the card reads publish `availableOperations` from, so a control this API
   * offers is never a request it then refuses.
   */
  private async assertOperationAvailable(
    card: CardEntity,
    operation: CardLifecycleOperation,
  ): Promise<void> {
    const application = await this.applicationRepository.findOne({
      where: { cardId: card.id },
      select: { id: true, cardProductId: true },
    });

    const [available = []] = await this.cardOperationAvailability.forCards([
      {
        providerKey: card.providerKey,
        cardProductId: application?.cardProductId ?? null,
      },
    ]);

    if (available.includes(operation)) return;

    throw new BadRequestException(
      `Card ${card.publicId} does not accept ${operation} — it accepts ${
        available.length > 0 ? available.join(', ') : 'no lifecycle operations'
      }`,
    );
  }

  /**
   * Writes the operation row before the issuer is called, answering a card
   * that already has one in flight with what it collided with.
   */
  private async writeDraft(
    card: CardEntity,
    operation: CardLifecycleOperation,
  ): Promise<CardOperationEntity> {
    try {
      return await this.operationRepository.save(
        this.operationRepository.create({
          cardId: card.id,
          // Read from the card row, never from a caller.
          providerKey: card.providerKey,
          operationType: operation,
          status: CardOperationStatus.DRAFT,
        }),
      );
    } catch (error) {
      if (!isDuplicateEntryError(error, CARD_OPERATION_IN_FLIGHT_INDEX)) {
        throw error;
      }

      // Caught from the constraint rather than from a prior read: a check-
      // then-insert has a window under concurrency exactly where two requests
      // arriving together land. The lookup below only composes the message.
      const inFlight = await this.operationRepository.findOne({
        where: {
          cardId: card.id,
          status: In([...IN_FLIGHT_CARD_OPERATION_STATUSES]),
        },
      });

      throw new ConflictException(
        `Card ${card.publicId} already has an operation with the provider` +
          // No identifier: the row has none, deliberately — an operation is
          // not addressable, and what became of it is read off the card.
          (inFlight
            ? ` (${inFlight.operationType}, requested ${inFlight.createdAt.toISOString()})`
            : '') +
          ' — the provider accepts one at a time',
      );
    }
  }

  /**
   * Runs the provider call and, if it fails, leaves the row saying how. Which
   * failure state depends on whether the issuer answered.
   */
  private async callProvider<T>(
    row: CardOperationEntity,
    card: CardEntity,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      await this.recordFailure(row, card, error);

      // Before the conflict below: only waiting clears this one. 429 not 409,
      // and it names the provider because this API throttles callers too.
      if (error instanceof CardProviderThrottledError) {
        throw new HttpException(
          `The card provider accepts one ${row.operationType} per card within 24 hours, and this card's has been used`,
          HttpStatus.TOO_MANY_REQUESTS,
          { cause: error },
        );
      }

      if (error instanceof CardProviderConflictError) {
        // A composed sentence, never `error.message`: that text is built from
        // the issuer's own wire content and carries their code and our
        // internal operation name, which is not ours to republish.
        throw new ConflictException(
          'The card provider refused this status change in its current state',
          { cause: error },
        );
      }

      throw error;
    }
  }

  private async recordFailure(
    row: CardOperationEntity,
    card: CardEntity,
    error: unknown,
  ): Promise<void> {
    // Both mean the issuer answered and declined.
    const refusal =
      error instanceof CardProviderConflictError ||
      error instanceof CardProviderThrottledError
        ? error
        : null;
    const refusedByIssuer = refusal !== null;
    const detail =
      error instanceof Error ? error.message : 'Unknown provider failure';

    this.logger.warn(
      refusedByIssuer
        ? `Card operation ${row.operationType} on card ${card.publicId} was refused by ${row.providerKey}: ${detail}`
        : `Card operation ${row.operationType} on card ${card.publicId} was not acknowledged by ${row.providerKey}: ${detail}`,
    );

    try {
      await this.operationRepository.update(
        { id: row.id },
        {
          // **REJECTED, not SUBMISSION_FAILED and not FAILED.** The first
          // would answer "was this ever sent?" wrongly; the second is a state
          // the issuer can be asked about, and it never took this request on.
          status: refusedByIssuer
            ? CardOperationStatus.REJECTED
            : CardOperationStatus.SUBMISSION_FAILED,
          reasonCode: (refusal
            ? refusal.providerCode
            : LOCAL_FAILURE_CODE
          ).slice(0, CARD_OPERATION_REASON_CODE_MAX_LENGTH),
          // Composed here, not copied from the provider's message. **The
          // second says "not acknowledged", never "not received"**: a refusal
          // the adapter could not translate reaches this branch too, and the
          // issuer did answer that one. Which of the two happened is only in
          // the log, because their code arrives on an adapter-local error a
          // use case cannot catch.
          message: (refusedByIssuer
            ? 'The card provider refused this status change'
            : 'The card provider did not acknowledge this status change'
          ).slice(0, CARD_OPERATION_MESSAGE_MAX_LENGTH),
        },
      );
    } catch (bookkeepingError) {
      // Its own guard, because these writes run in exactly the circumstances
      // that break writes: without it the repository's error would propagate
      // in place of the provider's, and the caller would hear the symptom
      // rather than the cause. A row left in DRAFT holds its card.
      this.logger.error(
        `Could not record the failed card operation on card ${card.publicId}, leaving it in ${row.status}: ${
          bookkeepingError instanceof Error
            ? bookkeepingError.message
            : String(bookkeepingError)
        }`,
      );
    }
  }
}
