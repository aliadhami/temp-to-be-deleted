import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { CardCapability } from '../domain/card-capability.enum';
import { supportsCapability } from '../domain/card-issuer-guards';
import { CardStatus } from '../domain/card-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { stampCheckedAt } from '../../shared/persistence/rotation-stamp.util';

/**
 * Every column a pass reads from `card`, named so the query stays narrow. The
 * loaded entity is therefore partial, so the write below goes through `update`
 * rather than `save`.
 */
const CARD_COLUMNS = {
  id: true,
  publicId: true,
  providerKey: true,
  providerCardId: true,
  statusCheckedAt: true,
  balanceAvailable: true,
  balanceLedger: true,
  balanceCurrency: true,
} as const;

/** What one card's reconcile produced, for the tally the pass logs. */
type Observation = 'updated' | 'unchanged' | 'skipped';

/**
 * Re-reads the balance of the cards an issuer holds for us. A bounded,
 * rotating pass rather than "every active card, every minute".
 */
@Injectable()
export class ReconcileCardBalancesUseCase {
  private readonly logger = new Logger(ReconcileCardBalancesUseCase.name);

  constructor(
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
    private readonly configService: ConfigService,
  ) {}

  async execute(): Promise<void> {
    const batchSize = this.batchSize();

    const cards = await this.cardRepository.find({
      where: {
        status: CardStatus.ACTIVE,
        // Excluded in the query rather than only in the loop: a card with no
        // provider card id cannot be asked about at all, so letting one into
        // the batch spends a slot that a card which *can* be read would use.
        providerCardId: Not(IsNull()),
      },
      select: CARD_COLUMNS,
      // Least-recently-checked first, with the id only as a tie-break among
      // cards stamped in the same batch. A card never checked sorts first,
      // MariaDB ordering nulls ahead of values on an ascending sort.
      order: { statusCheckedAt: 'ASC', id: 'ASC' },
      take: batchSize,
    });

    if (cards.length === 0) return;

    await this.stamp(cards);

    const tally = { updated: 0, unchanged: 0, skipped: 0, failed: 0 };

    for (const card of cards) {
      try {
        tally[await this.reconcileOne(card)] += 1;
      } catch (error) {
        // One card's failure must never abort the pass for the rest — the same
        // per-item isolation every other sweep uses. The row is left exactly as
        // it was apart from its stamp, so the next pass retries it once the
        // rest of the queue has had its turn.
        tally.failed += 1;
        this.logger.warn(
          `Balance reconcile failed for card ${card.publicId} (${card.providerKey}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.logger.log(
      `Card balance sweep examined ${cards.length} card(s): ${tally.updated} updated, ` +
        `${tally.unchanged} unchanged, ${tally.skipped} skipped, ${tally.failed} failed` +
        this.rotationLag(cards, batchSize),
    );
  }

  /**
   * How far behind the rotation is, when it is behind at all. A saturated
   * rotation has to be distinguishable from a healthy one — at the ceiling, a
   * queue hours behind otherwise logs exactly what a fully covered queue logs.
   */
  private rotationLag(cards: readonly CardEntity[], batchSize: number): string {
    if (cards.length < batchSize) return ', whole set covered';

    const oldest = cards[0]?.statusCheckedAt ?? null;
    if (oldest === null)
      return ', batch full — cards not yet asked about remain';

    const minutes = Math.round((Date.now() - oldest.getTime()) / 60_000);
    return `, batch full — oldest examined was last asked ${minutes}m ago`;
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

  private async reconcileOne(card: CardEntity): Promise<Observation> {
    const adapter = this.cardIssuerRegistry.resolve(card.providerKey);

    // A skip here rather than a filter in the query, deliberately. Both
    // providers declare this capability, so nothing is currently excluded and
    // a batch slot spent on a skipped row costs one loaded row rather than a
    // call.
    if (!supportsCapability(adapter, CardCapability.BALANCE_READ)) {
      return 'skipped';
    }

    // The query excluded NULL and this covers what it could not. The column
    // permits an empty string, which `IS NOT NULL` does not exclude — while
    // every other guard on this value tests for falsiness.
    if (!card.providerCardId) {
      this.logger.warn(
        `Card ${card.publicId} (${card.providerKey}) is active with an empty provider card id — nothing to ask a balance for`,
      );
      return 'skipped';
    }

    const balance = await adapter.getCardBalance(card.providerCardId, {});

    // One issuer answers null while a card is not yet in a balance-bearing
    // state — nothing to persist, and not an error. The other has no such state
    // and refuses instead, which arrives here as a throw.
    if (!balance) return 'unchanged';

    const unchanged =
      card.balanceAvailable === balance.available &&
      card.balanceLedger === balance.ledger &&
      card.balanceCurrency === balance.currencyCode;
    // The observation time alone does not make a row worth rewriting.
    if (unchanged) return 'unchanged';

    await this.cardRepository.update(card.id, {
      balanceAvailable: balance.available,
      balanceLedger: balance.ledger,
      balanceCurrency: balance.currencyCode,
      balanceObservedAt: new Date(balance.observedAt),
    });

    return 'updated';
  }

  /**
   * How many cards one pass may examine. Bounded because each one is a live
   * call, so an unbounded pass on a large estate would run until it had asked
   * about every card and overlap the pass behind it.
   */
  private batchSize(): number {
    return this.configService.getOrThrow<number>(
      'CARD_BALANCE_SWEEP_BATCH_SIZE',
    );
  }
}
