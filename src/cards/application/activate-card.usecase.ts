import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, QueryDeepPartialEntity, Repository } from 'typeorm';
import { WebhookDeliveryService } from '../../payments/infrastructure/webhooks/webhook-delivery.service';
import { isTransactionRestartError } from '../../shared/persistence/duplicate-entry.util';
import { CardActivationStatus } from '../domain/card-activation-status.enum';
import { CardCapability } from '../domain/card-capability.enum';
import { supportsCapability } from '../domain/card-issuer-guards';
import { CardEventSource } from '../domain/card-event-source.enum';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { CardProviderIntentRejectedError } from '../domain/card-provider-intent-rejected.error';
import { CardStatus } from '../domain/card-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import {
  CARD_EVENT_DETAIL_MAX_LENGTH,
  CardEventEntity,
} from '../infrastructure/persistence/card-event.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';

/**
 * Every activation field is optional here for the reason the intent records:
 * issuers activate cards by different means, and requiring the union would
 * demand of each values the other has no use for.
 */
export interface ActivateCardInput {
  partnerId: string;
  cardPublicId: string;
  pan?: string | null;
  expiryMonth?: number | null;
  expiryYear?: number | null;
  cvv?: string | null;
  pin?: string | null;
  activationDocument?: string | null;
}

/** The original attempt plus four restarts. */
const MAX_WRITE_ATTEMPTS = 5;

/**
 * How long a restarted write waits, multiplied by the attempt number and
 * jittered, so racers rolled back together do not queue up in lockstep. Small
 * on purpose: this runs inline on a partner's request.
 */
const RESTART_BASE_DELAY_MS = 10;

@Injectable()
export class ActivateCardUseCase {
  private readonly logger = new Logger(ActivateCardUseCase.name);

  constructor(
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    @InjectRepository(CardEventEntity)
    private readonly eventRepository: Repository<CardEventEntity>,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
    private readonly webhookDeliveryService: WebhookDeliveryService,
  ) {}

  async execute(input: ActivateCardInput) {
    const card = await this.cardRepository.findOne({
      where: { publicId: input.cardPublicId, partnerId: input.partnerId },
    });
    if (!card || !card.providerCardId)
      throw new NotFoundException('Card not found');
    // Captured once rather than re-read through the entity below, matching the
    // issuance path: the guard narrows a property access, and this is the value
    // the issuer keys the whole call on.
    const providerCardId = card.providerCardId;

    const adapter = this.cardIssuerRegistry.resolve(card.providerKey);
    if (!supportsCapability(adapter, CardCapability.ACTIVATE)) {
      throw new ForbiddenException(
        `Card provider "${card.providerKey}" does not support card activation`,
      );
    }

    // Only a card that has not been activated may be activated, and this guard
    // is load-bearing.
    if (card.status !== CardStatus.NOT_ACTIVATED) {
      throw new ConflictException(
        `Card ${card.publicId} is ${card.status.toLowerCase()} and cannot be activated`,
      );
    }

    // An issuer that settles afterwards is reviewing the document it already
    // has, and a second one would leave it holding two for one card with no
    // way to say which answer belongs to which. A refused attempt clears this,
    // so a corrected document still goes through.
    if (card.activationStatus === CardActivationStatus.PENDING) {
      throw new ConflictException(
        `Card ${card.publicId} already has an activation awaiting the provider — wait for its outcome before sending another`,
      );
    }

    const idempotencyKey = `activate-${card.publicId}`;
    const previousStatus = card.status;

    const result = await this.callProvider(() =>
      adapter.activateCard(
        {
          cardPublicId: card.publicId,
          providerCardId,
          // Conditional spreads throughout: under `exactOptionalPropertyTypes`
          // an absent optional cannot be set to undefined, and an absent field
          // here is ordinary rather than a loss — it means this issuer does not
          // use it. The adapter refuses the ones it does need.
          ...(input.pan != null && { pan: input.pan }),
          ...(input.expiryMonth != null && { expiryMonth: input.expiryMonth }),
          ...(input.expiryYear != null && { expiryYear: input.expiryYear }),
          ...(input.cvv != null && { cvv: input.cvv }),
          ...(input.pin != null && { pin: input.pin }),
          ...(input.activationDocument != null && {
            activationDocument: input.activationDocument,
          }),
        },
        {},
        idempotencyKey,
      ),
    );

    const statusChanged = result.status !== previousStatus;

    // Stamped only where the issuer has not finished *and* something exists to
    // clear it afterwards. Nothing but the status sweep resolves this column,
    // and that sweep only examines cards whose issuer can be asked what became
    // of an application — so stamping one that cannot be asked would leave a
    // card refusing every later attempt for ever. Such an issuer simply gets
    // no pending state, which is where every issuer stood before this column.
    const resolvable = supportsCapability(
      adapter,
      CardCapability.APPLICATION_RESULT,
    );
    // Written *after* the call rather than before it, against this codebase's
    // persist-first reflex, because an issuer that refuses the document must
    // leave the card immediately re-uploadable and a stamp written first would
    // have to be taken back on that path. The window this opens — accepted,
    // then the process dies before the write — is closed by that same sweep,
    // which reads the issuer's own activation stage and stamps what it finds.
    const activationStatus =
      result.status === CardStatus.ACTIVE || !resolvable
        ? null
        : CardActivationStatus.PENDING;
    // Cleared unconditionally: whatever an earlier attempt was refused for is
    // not why this one is outstanding.
    const activationChanged =
      activationStatus !== card.activationStatus ||
      card.activationReasonCode !== null ||
      card.activationReason !== null;

    if (statusChanged || activationChanged) {
      const changes: QueryDeepPartialEntity<CardEntity> = {
        ...(statusChanged && { status: result.status }),
        ...(activationChanged && {
          activationStatus,
          activationReasonCode: null,
          activationReason: null,
        }),
      };

      // A compare-and-set rather than a save, because this is not the only
      // writer.
      //
      // **It matches on the activation as well as the status, and that is what
      // makes the pending guard above more than advisory.** For an issuer that
      // acknowledges and settles afterwards the status does not move on this
      // call, so a predicate naming only the status matches for every racer
      // alike — two concurrent requests would both stamp the card and both
      // record an event. Naming the activation this request read is what lets
      // exactly one of them win. A null is matched with `IsNull()` rather than
      // written literally, or the comparison is against SQL `NULL` and never
      // matches at all.
      const seenActivation = card.activationStatus;
      const written = await this.withRestart(
        `The activation of card ${card.publicId}`,
        () =>
          this.cardRepository.update(
            {
              id: card.id,
              status: previousStatus,
              activationStatus:
                seenActivation === null ? IsNull() : seenActivation,
            },
            changes,
          ),
      );

      if (written.affected === 0) {
        this.logger.warn(
          `Card ${card.publicId} was changed by something else while its activation was in flight — leaving whatever changed it to report the change`,
        );

        // The request is still recorded, and it records a request rather than
        // a transition. The issuer accepted this activation, so dropping the
        // row would lose the only evidence a partner asked for it.
        await this.recordEvent(
          card,
          previousStatus,
          previousStatus,
          'Activation accepted by the provider; the card had already been changed and another writer recorded the change',
        );

        const current = await this.cardRepository.findOne({
          where: { id: card.id },
          select: { status: true, activationStatus: true },
        });

        return {
          publicId: card.publicId,
          status: current?.status ?? result.status,
          activationStatus: current?.activationStatus ?? null,
        };
      }

      card.status = result.status;
      card.activationStatus = activationStatus;
      card.activationReasonCode = null;
      card.activationReason = null;
    }

    // Written even when the status did not move, matching what the issuance
    // path does for an application that is only acknowledged: for an issuer
    // that activates asynchronously this is the record that activation was
    // requested and accepted, which is otherwise nowhere.
    await this.recordEvent(
      card,
      previousStatus,
      result.status,
      statusChanged
        ? null
        : 'Activation accepted by the provider; the card is not usable until the provider settles it',
    );

    // Announced only when the card really is usable.
    if (result.status === CardStatus.ACTIVE) {
      await this.webhookDeliveryService.enqueueForCard(
        card.id,
        card.partnerId,
        'card.activated',
        {
          eventType: 'card.activated',
          cardPublicId: card.publicId,
          status: result.status,
          occurredAt: new Date().toISOString(),
        },
      );
    }

    return {
      publicId: card.publicId,
      status: card.status,
      // Returned beside the status because the status alone cannot say whether
      // this request landed — for this shape of issuer it does not move.
      activationStatus: card.activationStatus,
    };
  }

  private async recordEvent(
    card: CardEntity,
    fromStatus: CardStatus,
    toStatus: CardStatus,
    detail: string | null,
  ): Promise<void> {
    await this.withRestart(
      `The activation event for card ${card.publicId}`,
      () =>
        this.eventRepository.save(
          this.eventRepository.create({
            cardId: card.id,
            fromStatus,
            toStatus,
            source: CardEventSource.SYSTEM,
            detail: detail?.slice(0, CARD_EVENT_DETAIL_MAX_LENGTH) ?? null,
          }),
        ),
    );
  }

  /**
   * Runs one write, restarting it when the server rolled it back as a deadlock
   * victim — `card` and `card_event` have several writers. Each write is a
   * single statement that left nothing behind, so a restart repeats it rather
   * than doubling it. It wraps the writes and never the call above them, which
   * the issuer has already accepted.
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
          await this.pauseBeforeRestart(attempt);
          continue;
        }

        // Anything else is the failure the caller has to see, unchanged.
        throw error;
      }
    }
  }

  private pauseBeforeRestart(attempt: number): Promise<void> {
    const ceiling = RESTART_BASE_DELAY_MS * attempt;
    return new Promise((resolve) =>
      setTimeout(resolve, Math.random() * ceiling),
    );
  }

  /**
   * Answers the refusals an issuer can raise on this call with something a
   * partner can act on. The branch is the error type, never the provider key,
   * so an issuer added later needs no edit here.
   */
  private async callProvider<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      // The adapter refused a value before sending it, knowing its issuer's own
      // documented requirements — a missing activation document, or a missing
      // printed card detail. The message already names the field in our
      // vocabulary, so it is handed over as it stands.
      if (error instanceof CardProviderIntentRejectedError) {
        throw new BadRequestException(error.message, { cause: error });
      }

      // The issuer refused over the state of things — a card already
      // activated, one they have cancelled, a duplicate request.
      if (error instanceof CardProviderConflictError) {
        throw new ConflictException(
          'The card provider refused to activate this card in its current state — it may already be activated, or no longer open',
          { cause: error },
        );
      }

      throw error;
    }
  }
}
