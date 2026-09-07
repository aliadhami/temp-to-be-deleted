import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, Repository } from 'typeorm';
import { CardLifecycleOperation } from '../domain/card-lifecycle-operation.enum';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardApplicationEntity } from '../infrastructure/persistence/card-application.entity';
import { CardOperationEntity } from '../infrastructure/persistence/card-operation.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';
import { CardOperationAvailability } from './card-operation-availability';
import { toCardResponse } from './card-projection';

/**
 * What the card reads take off an application — never `response_payload`.
 * `cardProductId` is here because it is the only link from a card to its
 * product; the card row deliberately carries no copy of it.
 */
const APPLICATION_COLUMNS = {
  cardId: true,
  cardProductId: true,
  status: true,
  reasonCode: true,
  message: true,
  statusCheckedAt: true,
} as const;

/** What the card reads take off a cardholder — never the identity material. */
const CARDHOLDER_COLUMNS = { id: true, publicId: true } as const;

/**
 * What the card reads take off an operation — never `response_payload`, and
 * never `request_reference`, which is not exposed.
 */
const OPERATION_SELECTION = [
  'operation.id',
  'operation.cardId',
  'operation.operationType',
  'operation.status',
  'operation.reasonCode',
  'operation.message',
  'operation.createdAt',
  'operation.statusCheckedAt',
];

/** Paired explicitly, so nothing downstream re-derives which belongs to which. */
type CardWithApplication = readonly [CardEntity, CardApplicationEntity | null];

export interface ListCardsForPartnerInput {
  partnerId: string;
  page: number;
  limit: number;
  status?: CardStatus;
  cardholderPublicId?: string;
  providerKey?: CardProviderKey;
}

@Injectable()
export class GetCardUseCase {
  constructor(
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    @InjectRepository(CardholderEntity)
    private readonly cardholderRepository: Repository<CardholderEntity>,
    @InjectRepository(CardApplicationEntity)
    private readonly applicationRepository: Repository<CardApplicationEntity>,
    @InjectRepository(CardOperationEntity)
    private readonly operationRepository: Repository<CardOperationEntity>,
    private readonly cardOperationAvailability: CardOperationAvailability,
  ) {}

  async execute(partnerId: string, publicId: string) {
    const card = await this.cardRepository.findOne({
      where: { publicId, partnerId },
    });
    if (!card) throw new NotFoundException('Card not found');

    const application = await this.applicationRepository.findOne({
      where: { cardId: card.id },
      select: APPLICATION_COLUMNS,
    });

    // Independent of each other, so they go together rather than costing
    // three round trips.
    const [[operations = []], lastOperations, cardholders] = await Promise.all([
      this.availableOperations([[card, application]]),
      this.lastOperationsByCardId([card]),
      this.cardholdersById([card]),
    ]);

    return toCardResponse(
      card,
      this.cardholderOf(card, cardholders),
      application,
      operations,
      lastOperations.get(card.id) ?? null,
    );
  }

  async listForPartner(input: ListCardsForPartnerInput) {
    const { partnerId, page, limit } = input;
    const where: FindOptionsWhere<CardEntity> = { partnerId };
    if (input.status) where.status = input.status;
    if (input.providerKey) where.providerKey = input.providerKey;

    let knownCardholders: Map<string, CardholderEntity> | null = null;

    if (input.cardholderPublicId) {
      const cardholder = await this.cardholderRepository.findOne({
        where: { publicId: input.cardholderPublicId, partnerId },
        select: CARDHOLDER_COLUMNS,
      });
      if (!cardholder) throw new NotFoundException('Cardholder not found');
      where.cardholderId = cardholder.id;
      // The filter admits only this person's cards, so the page's are all here.
      knownCardholders = new Map([[cardholder.id, cardholder]]);
    }

    const [items, total] = await this.cardRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const applications = await this.applicationsByCardId(items);
    const pairs = items.map(
      (card) =>
        [card, applications.get(card.id) ?? null] as CardWithApplication,
    );
    const [operations, lastOperations, cardholders] = await Promise.all([
      this.availableOperations(pairs),
      this.lastOperationsByCardId(items),
      knownCardholders ?? this.cardholdersById(items),
    ]);

    return {
      items: pairs.map(([card, application], index) =>
        toCardResponse(
          card,
          this.cardholderOf(card, cardholders),
          application,
          operations[index] ?? [],
          lastOperations.get(card.id) ?? null,
        ),
      ),
      page,
      limit,
      total,
    };
  }

  /** One keyed query per page, never one per row. */
  private async applicationsByCardId(
    cards: readonly CardEntity[],
  ): Promise<Map<string, CardApplicationEntity>> {
    if (cards.length === 0) return new Map();

    const applications = await this.applicationRepository.find({
      where: { cardId: In(cards.map((card) => card.id)) },
      select: APPLICATION_COLUMNS,
    });

    return new Map(
      applications.map((application) => [application.cardId, application]),
    );
  }

  /** One keyed query per page, never one per row. */
  private async cardholdersById(
    cards: readonly CardEntity[],
  ): Promise<Map<string, CardholderEntity>> {
    if (cards.length === 0) return new Map();

    const cardholders = await this.cardholderRepository.find({
      where: { id: In([...new Set(cards.map((card) => card.cardholderId))]) },
      select: CARDHOLDER_COLUMNS,
    });

    return new Map(
      cardholders.map((cardholder) => [cardholder.id, cardholder]),
    );
  }

  /**
   * The foreign key makes a missing row impossible, so one is a broken row to
   * fail on. **On the list this fails the whole page** — never soften it to
   * dropping the card.
   */
  private cardholderOf(
    card: CardEntity,
    cardholders: ReadonlyMap<string, CardholderEntity>,
  ): CardholderEntity {
    const cardholder = cardholders.get(card.cardholderId);
    if (!cardholder) {
      throw new Error(
        `Card ${card.publicId} names a cardholder that does not exist`,
      );
    }
    return cardholder;
  }

  /**
   * What each card accepts now, aligned to the pairs given. The narrowing
   * itself lives in the helper the lifecycle request path validates through,
   * so a control this read draws is a request that path accepts.
   */
  private availableOperations(
    pairs: readonly CardWithApplication[],
  ): Promise<CardLifecycleOperation[][]> {
    return this.cardOperationAvailability.forCards(
      pairs.map(([card, application]) => ({
        providerKey: card.providerKey,
        cardProductId: application?.cardProductId ?? null,
      })),
    );
  }

  /**
   * The most recent operation per card — **the most recent, not the one in
   * flight**: a failed block leaves `card.status` untouched and the issuer
   * gives no reason, so the message on that row is the only place a partner
   * can learn it failed.
   *
   * One statement per page. The id stands in for recency because it is
   * monotonic and this table, unlike `card_application`, holds many rows per
   * card. Measured plan: the grouping is a `range` over
   * `idx_card_operation_card_created` with `Using index`, then one `eq_ref` on
   * the primary key per surviving row. No filesort, and the table is never
   * touched to find the maxima.
   */
  private async lastOperationsByCardId(
    cards: readonly CardEntity[],
  ): Promise<Map<string, CardOperationEntity>> {
    if (cards.length === 0) return new Map();

    const cardIds = cards.map((card) => card.id);
    // From the metadata, never a literal: this is the one place the table is
    // named in SQL rather than through the entity, and a rename has to follow.
    const table = this.operationRepository.metadata.tableName;
    const operations = await this.operationRepository
      .createQueryBuilder('operation')
      .select(OPERATION_SELECTION)
      .where('operation.card_id IN (:...cardIds)', { cardIds })
      .andWhere(
        `operation.id IN (SELECT MAX(latest.id) FROM ${table} latest` +
          ' WHERE latest.card_id IN (:...cardIds) GROUP BY latest.card_id)',
      )
      .getMany();

    return new Map(
      operations.map((operation) => [operation.cardId, operation]),
    );
  }
}
