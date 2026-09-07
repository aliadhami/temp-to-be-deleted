import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, QueryDeepPartialEntity, Repository } from 'typeorm';
import { WebhookDeliveryService } from '../../payments/infrastructure/webhooks/webhook-delivery.service';
import { stampCheckedAt } from '../../shared/persistence/rotation-stamp.util';
import { CardCapability } from '../domain/card-capability.enum';
import {
  CardDepositStatus,
  OUTSTANDING_CARD_DEPOSIT_STATUSES,
} from '../domain/card-deposit-status.enum';
import { CardDepositOutcome } from '../domain/card-issuer.port';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import {
  CardCallbackResolution,
  providerReportsOutcome,
} from './card-callback-resolution';
import {
  CARD_DEPOSIT_MESSAGE_MAX_LENGTH,
  CARD_DEPOSIT_REASON_CODE_MAX_LENGTH,
  CardDepositEntity,
} from '../infrastructure/persistence/card-deposit.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';

/** Every column a pass reads, named so the query stays narrow. */
const DEPOSIT_COLUMNS = {
  id: true,
  publicId: true,
  cardId: true,
  providerKey: true,
  // The partner's own key, read only so the notification below can carry it —
  // a partner matches a deposit event against the request they made, not
  // against an identifier of ours.
  requestId: true,
  providerReference: true,
  providerDepositId: true,
  currencyCode: true,
  status: true,
  // Read so the write can compare rather than overwrite. Their status and the
  // detail hanging off it do not move in lockstep — a deposit can sit at their
  // failure status while the reason changes — so a pass that did not load these
  // could only decide whether to write by looking at the status alone.
  creditedAmount: true,
  reasonCode: true,
  message: true,
} as const;

/** Every column a pass reads from `card`, for the same reason. */
const CARD_COLUMNS = {
  id: true,
  publicId: true,
  partnerId: true,
  providerCardId: true,
} as const;

/** What one deposit's examination produced, for the tally the pass logs. */
type Observation = 'settled' | 'moved' | 'unchanged' | 'unresolved';

/**
 * An outcome that actually carries a status — everything except the two arms
 * meaning "ask again". Named rather than restated at each helper, so an arm
 * added to the union is one edit instead of three identical generics.
 */
type ResolvedCardDepositOutcome = Exclude<
  CardDepositOutcome,
  { state: 'PENDING' } | { state: 'UNKNOWN_REFERENCE' }
>;

/** The deposit status each outcome the issuer can report corresponds to. */
const STATUS_BY_OUTCOME = {
  SETTLED: CardDepositStatus.SETTLED,
  FAILED: CardDepositStatus.FAILED,
  REFUND_PENDING: CardDepositStatus.REFUND_PENDING,
  REFUNDED: CardDepositStatus.REFUNDED,
} as const satisfies Record<
  Exclude<CardDepositOutcome['state'], 'PENDING' | 'UNKNOWN_REFERENCE'>,
  CardDepositStatus
>;

/**
 * Turns a deposit an issuer acknowledged into a fact, by asking what became of
 * it. Nothing tells us when that happens.
 */
@Injectable()
export class ResolveCardDepositsUseCase {
  private readonly logger = new Logger(ResolveCardDepositsUseCase.name);

  constructor(
    @InjectRepository(CardDepositEntity)
    private readonly depositRepository: Repository<CardDepositEntity>,
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
    private readonly webhookDeliveryService: WebhookDeliveryService,
    private readonly configService: ConfigService,
  ) {}

  async execute(): Promise<void> {
    // Applied in the query rather than in the loop: a row belonging to a
    // provider that can never answer is work that will never be done, and
    // skipping it after loading still spends the batch on it.
    const providerKeys = this.cardIssuerRegistry.keysWithCapability(
      CardCapability.DEPOSIT,
    );
    // No issuer on this deployment takes deposits by request, so there is no
    // work here at all — and nothing to query for.
    if (providerKeys.length === 0) return;

    // Counted as well as taken, so a saturated rotation is visible.
    const [deposits, waiting] = await this.depositRepository.findAndCount({
      where: {
        // Derived from the enum rather than listed here, so a status added
        // later is polled by default. The two sets it is derived from — the
        // terminal states, and the states in which the issuer never received a
        // request — each say why they are excluded at the member itself.
        status: In(OUTSTANDING_CARD_DEPOSIT_STATUSES),
        providerKey: In(providerKeys),
      },
      select: DEPOSIT_COLUMNS,
      // Least-recently-checked first, with the id only as a tie-break among
      // deposits stamped in the same batch. A deposit never checked sorts
      // first, MariaDB ordering nulls ahead of values on an ascending sort.
      order: { statusCheckedAt: 'ASC', id: 'ASC' },
      take: this.batchSize(),
    });

    if (deposits.length === 0) return;

    await this.stamp(deposits);

    const cardsById = await this.loadCards(deposits);

    const tally = {
      settled: 0,
      moved: 0,
      unchanged: 0,
      unresolved: 0,
      failed: 0,
    };

    for (const deposit of deposits) {
      const card = cardsById.get(deposit.cardId);
      if (!card?.providerCardId) {
        // The foreign key makes a missing card unreachable while the row
        // exists, and the request path refuses a card with no issuer id — so
        // this is a row written some other way.
        tally.failed += 1;
        this.logger.warn(
          `Card deposit ${deposit.publicId} (${deposit.providerKey}) points at a card with no issuer card id — nothing to look its settlement up by`,
        );
        continue;
      }

      try {
        // The issuer card id is passed as its own argument rather than re-read
        // and asserted downstream: the guard that proved it non-null is right
        // here, and an assertion three frames away is one nothing keeps honest.
        tally[await this.observeOne(deposit, card, card.providerCardId)] += 1;
      } catch (error) {
        // One deposit's failure must never abort the pass for the rest — the
        // same per-item isolation every other sweep here uses. The row is left
        // exactly as it was apart from its stamp, so the next pass retries it
        // once the rest of the queue has had its turn.
        tally.failed += 1;
        this.logger.warn(
          `Could not read the settlement of card deposit ${deposit.publicId} (${deposit.providerKey}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.logger.log(
      `Card deposit settlement sweep examined ${deposits.length} of ${waiting} outstanding: ${tally.settled} settled, ` +
        `${tally.moved} otherwise moved, ${tally.unchanged} unchanged, ${tally.unresolved} not answered for, ` +
        `${tally.failed} failed`,
    );
  }

  /**
   * Resolves the one deposit an issuer has just named, for a caller that
   * learned of an outcome instead of waiting for the rotation.
   *
   * **Keyed on `provider_reference`, never on `request_id`** — the partner's
   * key was never sent, so it cannot be what an issuer echoes back.
   */
  async resolveOneByProviderReference(
    providerKey: CardProviderKey,
    providerReference: string,
  ): Promise<CardCallbackResolution> {
    if (
      !providerReportsOutcome(
        this.cardIssuerRegistry,
        CardCapability.DEPOSIT,
        providerKey,
      )
    ) {
      return 'NO_ROW';
    }

    const deposit = await this.depositRepository.findOne({
      where: {
        status: In(OUTSTANDING_CARD_DEPOSIT_STATUSES),
        providerKey,
        providerReference,
      },
      select: DEPOSIT_COLUMNS,
    });

    if (deposit === null) return 'NO_ROW';

    // Or the row keeps its old stamp and jumps every later rotation.
    await this.stamp([deposit]);

    const card = (await this.loadCards([deposit])).get(deposit.cardId);
    if (!card?.providerCardId) {
      this.logger.warn(
        `Card deposit ${deposit.publicId} (${deposit.providerKey}) points at a card with no issuer card id — nothing to look its settlement up by`,
      );
      return 'UNRESOLVABLE';
    }

    await this.observeOne(deposit, card, card.providerCardId);
    return 'RESOLVED';
  }

  /**
   * Records that this pass looked at these deposits. One statement for the
   * whole batch, written before any of them is examined, and whatever the
   * examination then does.
   */
  private async stamp(deposits: readonly CardDepositEntity[]): Promise<void> {
    await stampCheckedAt(
      this.depositRepository,
      'card_deposit',
      deposits.map((deposit) => deposit.id),
    );
  }

  private async loadCards(
    deposits: readonly CardDepositEntity[],
  ): Promise<Map<string, CardEntity>> {
    const cards = await this.cardRepository.find({
      where: { id: In(deposits.map((deposit) => deposit.cardId)) },
      select: CARD_COLUMNS,
    });

    return new Map(cards.map((card) => [card.id, card]));
  }

  private async observeOne(
    deposit: CardDepositEntity,
    card: CardEntity,
    providerCardId: string,
  ): Promise<Observation> {
    // No capability check: both callers select only rows belonging to a
    // provider that declares the flag, and a third check here would be
    // unreachable — as well as inviting a later reader to treat the filter as
    // optional, which is the thing that makes the batch starve.
    const adapter = this.cardIssuerRegistry.resolve(deposit.providerKey);

    const outcome = await adapter.getCardDepositResult(
      providerCardId,
      // Read from the row rather than rebuilt from anything else: the issuer's
      // lookup is keyed on the exact reference they were given, so a second
      // derivation is a second place it can drift from what they hold.
      deposit.providerReference,
      {},
    );

    if (outcome.state === 'UNKNOWN_REFERENCE') {
      // Left exactly as it was, deliberately.
      this.logger.warn(
        `Card provider "${deposit.providerKey}" does not hold card deposit ${deposit.publicId}, which it previously accepted — leaving it to be asked about again`,
      );
      return 'unresolved';
    }

    if (outcome.state === 'PENDING') {
      // Nothing written on purpose: a pending answer carries no new fact, and
      // writing it would rewrite every outstanding row on every pass.
      return 'unchanged';
    }

    if (
      outcome.providerDepositId !== undefined &&
      deposit.providerDepositId !== null &&
      outcome.providerDepositId !== deposit.providerDepositId
    ) {
      // Their answer names a different deposit than the one this reference
      // produced. Recording a settlement read off some other deposit is worse
      // than recording nothing, and it is not a disagreement this pass can
      // settle.
      this.logger.warn(
        `Card provider "${deposit.providerKey}" reports deposit "${outcome.providerDepositId}" for reference ${deposit.providerReference}, but card deposit ${deposit.publicId} holds "${deposit.providerDepositId}" — leaving it alone`,
      );
      return 'unresolved';
    }

    return this.recordOutcome(deposit, card, outcome);
  }

  /**
   * Persists whatever the answer actually changed, and nothing it did not. A
   * pass that found nothing new writes nothing.
   */
  private async recordOutcome(
    deposit: CardDepositEntity,
    card: CardEntity,
    outcome: ResolvedCardDepositOutcome,
  ): Promise<Observation> {
    const previousStatus = deposit.status;
    const status = STATUS_BY_OUTCOME[outcome.state];
    const statusChanged = status !== previousStatus;

    const { reasonCode, message } = this.failureReason(outcome);
    const reasonChanged =
      reasonCode !== deposit.reasonCode || message !== deposit.message;

    // Filled in when it arrives and never blanked: an issuer that reports its
    // identifier late means "not sent this time" rather than "this deposit has
    // none", and overwriting a stored one with nothing would lose the only
    // copy. A value that disagrees was refused before reaching here.
    const providerDepositId =
      deposit.providerDepositId === null &&
      outcome.providerDepositId !== undefined
        ? outcome.providerDepositId
        : null;

    const { creditedAmount } = this.creditedAmount(deposit, outcome);
    const creditedAmountArrived =
      creditedAmount !== undefined && creditedAmount !== deposit.creditedAmount;

    // Every fact the answer carries is compared, not just the status.
    if (
      !statusChanged &&
      !reasonChanged &&
      !creditedAmountArrived &&
      providerDepositId === null
    ) {
      return 'unchanged';
    }

    const changes: QueryDeepPartialEntity<CardDepositEntity> = {
      status,
      reasonCode,
      message,
      // Conditional spreads, so a field with nothing new to say is left out of
      // the statement rather than rewritten with what it already holds.
      ...(creditedAmountArrived && { creditedAmount }),
      ...(providerDepositId !== null && { providerDepositId }),
      // The lookup's answer is the payload worth replaying — the
      // acknowledgement this row was written from carries no outcome.
      responsePayload: outcome.rawPayload as QueryDeepPartialEntity<
        Record<string, unknown>
      >,
    };

    // Conditional on the status this pass actually read, which makes the write
    // safe against anything that moved the deposit since the batch was loaded.
    const written = await this.depositRepository.update(
      { id: deposit.id, status: previousStatus },
      changes,
    );

    if (written.affected === 0) {
      this.logger.warn(
        `Card deposit ${deposit.publicId} moved out of ${previousStatus} while this pass was reading it — leaving whatever changed it to report the change`,
      );
      return 'unresolved';
    }

    if (outcome.state === 'FAILED' && (statusChanged || reasonChanged)) {
      // Guarded on the change rather than on the state, so a deposit sitting at
      // their failure status across many passes is warned about when the
      // failure is news and not on every rotation.
      this.logger.warn(
        `Card provider "${deposit.providerKey}" failed card deposit ${deposit.publicId}` +
          (outcome.reason ? `: ${outcome.reason}` : '') +
          ' — their failure status is not final, so this deposit is still watched in case it is refunded',
      );
    }

    // **Only a status transition is announced.** A corrected reason or a
    // late-arriving identifier is worth recording and is not worth a second
    // event carrying a status the partner was already told.
    if (statusChanged) await this.announce(deposit, card, status);

    if (!statusChanged) return 'moved';

    return outcome.state === 'SETTLED' ? 'settled' : 'moved';
  }

  /**
   * What the issuer says actually landed, recorded only when it is denominated
   * in the currency this deposit was made in. A credited amount in the wrong
   * currency is worse than none.
   */
  private creditedAmount(
    deposit: CardDepositEntity,
    outcome: ResolvedCardDepositOutcome,
  ): { creditedAmount?: string } {
    if (outcome.state !== 'SETTLED') return {};

    const credited = outcome.creditedCurrencyCode;
    if (
      credited !== undefined &&
      credited.toUpperCase() !== deposit.currencyCode.toUpperCase()
    ) {
      this.logger.warn(
        `Card provider "${deposit.providerKey}" settled card deposit ${deposit.publicId} in ${credited}, but it was made in ${deposit.currencyCode} — recording the settlement without a credited amount rather than one in the wrong currency`,
      );
      return {};
    }

    return { creditedAmount: outcome.creditedAmount };
  }

  /**
   * The issuer's own words for a failure, cut to the columns that hold them.
   * Truncated before it is stored, to the widths declared on the entity.
   */
  private failureReason(outcome: ResolvedCardDepositOutcome): {
    reasonCode: string | null;
    message: string | null;
  } {
    if (outcome.state !== 'FAILED') {
      return { reasonCode: null, message: null };
    }

    return {
      reasonCode:
        outcome.reasonCode?.slice(0, CARD_DEPOSIT_REASON_CODE_MAX_LENGTH) ??
        null,
      // The issuer's own text, unlike the request path's composed sentence.
      // That path stores a refusal built around a provider error's message,
      // which carries their HTTP status, their code and our internal operation
      // name.
      message:
        outcome.reason?.slice(0, CARD_DEPOSIT_MESSAGE_MAX_LENGTH) ?? null,
    };
  }

  /**
   * Tells the partner their deposit moved. On every transition this pass
   * records, not only the terminal ones.
   */
  private async announce(
    deposit: CardDepositEntity,
    card: CardEntity,
    status: CardDepositStatus,
  ): Promise<void> {
    try {
      await this.webhookDeliveryService.enqueueForCard(
        card.id,
        card.partnerId,
        'card_deposit.status_updated',
        {
          eventType: 'card_deposit.status_updated',
          cardPublicId: card.publicId,
          depositPublicId: deposit.publicId,
          // Their own key, so a partner can match this against the request they
          // made without holding our identifier.
          requestId: deposit.requestId,
          status,
          occurredAt: new Date().toISOString(),
        },
      );
    } catch (error) {
      // Caught here rather than left to the loop, because by this point the
      // read succeeded and the row has already moved.
      this.logger.error(
        `Card deposit ${deposit.publicId} reached ${status} and the partner could not be notified — the deposit is recorded and no further attempt will be made: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * How many deposits one pass may examine. Bounded because each is a live
   * call to an issuer, so an unbounded pass on a large backlog would overlap
   * the pass behind it.
   */
  private batchSize(): number {
    return this.configService.getOrThrow<number>(
      'CARD_DEPOSIT_SWEEP_BATCH_SIZE',
    );
  }
}
