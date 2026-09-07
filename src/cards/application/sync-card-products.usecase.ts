import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  In,
  QueryDeepPartialEntity,
  QueryFailedError,
  UpdateQueryBuilder,
} from 'typeorm';
import { isTransactionRestartError } from '../../shared/persistence/duplicate-entry.util';
import { CardCapability } from '../domain/card-capability.enum';
import { CardProductActivationMode } from '../domain/card-product-activation-mode.enum';
import { CardProviderCatalogueNotStoredError } from '../domain/card-provider-catalogue-not-stored.error';
import { CardProviderCatalogueUnavailableError } from '../domain/card-provider-catalogue-unavailable.error';
import { assertCardCapability } from './assert-card-capability';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardProductListing } from '../domain/card-issuer.port';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardProductEntity } from '../infrastructure/persistence/card-product.entity';

/** The original attempt plus four restarts. */
const MAX_PERSIST_ATTEMPTS = 5;

/**
 * How long a restarted attempt waits, multiplied by the attempt number and
 * jittered. Without a pause the budget is spent in milliseconds: the victim
 * retries immediately into peers that still hold the locks and loses again.
 */
const RESTART_BASE_DELAY_MS = 10;

/**
 * Every column of `card_product` a catalogue read is responsible for: the
 * identity columns are the caller's, the timestamps the database's. `Omit`
 * rather than `Partial` so a new column has to be mapped here or this stops
 * compiling.
 */
type CardProductRowFields = Omit<
  CardProductEntity,
  | 'id'
  | 'publicId'
  | 'providerKey'
  | 'providerProductId'
  | 'createdAt'
  | 'updatedAt'
  | 'assignPublicId'
>;

/** One row of an upsert: the sync's columns plus the identity it is keyed by. */
interface CardProductRow extends CardProductRowFields {
  publicId: string;
  providerKey: CardProviderKey;
  providerProductId: string;
}

/**
 * The columns the upsert overwrites when the row already exists, as the
 * database names them. `public_id` is not here, and that is the whole point.
 */
const UPSERT_COLUMNS: Record<keyof CardProductRowFields, string> = {
  displayName: 'display_name',
  cardType: 'card_type',
  cardOrganisation: 'card_organisation',
  material: 'material',
  currencyCode: 'currency_code',
  issuanceFeeAmount: 'issuance_fee_amount',
  issuanceFeeCurrency: 'issuance_fee_currency',
  annualFeeAmount: 'annual_fee_amount',
  annualFeeCurrency: 'annual_fee_currency',
  depositFeePercent: 'deposit_fee_percent',
  depositMinPerTransaction: 'deposit_min_per_transaction',
  depositMaxPerTransaction: 'deposit_max_per_transaction',
  depositMaxPerDay: 'deposit_max_per_day',
  requiresInitialDeposit: 'requires_initial_deposit',
  depositMinInitial: 'deposit_min_initial',
  applicationMode: 'application_mode',
  requiresKyc: 'requires_kyc',
  activationMode: 'activation_mode',
  activationRequiresIdentityDocument: 'activation_requires_identity_document',
  sensitiveDetailMode: 'sensitive_detail_mode',
  availableForIssuance: 'available_for_issuance',
  supportedOperations: 'supported_operations',
  rawPayload: 'raw_payload',
  syncedAt: 'synced_at',
};

export interface SyncCardProductsResult {
  providerKey: CardProviderKey;
  received: number;
  /**
   * How many products this run inserted, and how many were already there. Null
   * when the snapshot was stored but could not be counted — the count is a
   * separate read taken after the commit, so it can fail on its own.
   */
  created: number | null;
  updated: number | null;
  markedUnavailable: number;
  syncedAt: Date;
}

/**
 * Turns a provider's catalogue into `card_product` rows — an identity map, not
 * a cache.
 */
@Injectable()
export class SyncCardProductsUseCase {
  private readonly logger = new Logger(SyncCardProductsUseCase.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
  ) {}

  async execute(providerKey: CardProviderKey): Promise<SyncCardProductsResult> {
    const adapter = this.cardIssuerRegistry.resolve(providerKey);
    // Shared with the catalogue read, which gates on the same capability before
    // it touches the table — one function so the two cannot drift to different
    // messages or statuses.
    assertCardCapability(
      adapter,
      CardCapability.PRODUCT_CATALOGUE,
      providerKey,
      'a product catalogue',
    );

    let listings: CardProductListing[];
    try {
      listings = await adapter.listCardProducts({});
    } catch (error) {
      // The call failed before anything was read or written — the previous
      // snapshot is untouched by construction, not by a rollback.
      throw new CardProviderCatalogueUnavailableError(providerKey, {
        cause: error,
      });
    }

    /**
     * One timestamp for the whole run, so every row agrees on when it was last
     * confirmed. A UTC instant, and the only timestamp on this table meaning
     * "checked against the provider".
     */
    const syncedAt = new Date();

    const rows = this.toRows(providerKey, listings, syncedAt);
    const markedUnavailable = await this.writeWithRetry(
      providerKey,
      rows,
      syncedAt,
    );

    // Only once the write is durable, and never inside it. Counting is
    // reporting: it cannot undo a stored snapshot and must not be able to
    // report one as unstored, which is what running it inside the retry did.
    const created = await this.countInserted(providerKey, rows);
    const updated = created === null ? null : rows.length - created;

    if (markedUnavailable > 0) {
      this.logger.warn(
        `Card provider "${providerKey}" catalogue read withdrew ${markedUnavailable} product(s) from issuance — stored but absent from this response`,
      );
    }
    if (listings.length === 0) {
      this.logger.warn(
        `Card provider "${providerKey}" catalogue read returned no products at all`,
      );
    }
    this.logger.log(
      `Card provider "${providerKey}" catalogue synced: received=${listings.length} created=${created ?? 'unknown'} updated=${updated ?? 'unknown'} withdrawn=${markedUnavailable}`,
    );

    return {
      providerKey,
      received: listings.length,
      created,
      updated,
      markedUnavailable,
      syncedAt,
    };
  }

  /**
   * Runs the write phase in one transaction, absorbing a deadlock and
   * containing everything else. Returns how many products it withdrew.
   */
  private async writeWithRetry(
    providerKey: CardProviderKey,
    rows: CardProductRow[],
    syncedAt: Date,
  ): Promise<number> {
    for (let attempt = 1; ; attempt++) {
      try {
        // One transaction for the whole write phase.
        return await this.dataSource.transaction((manager) =>
          this.persist(manager, providerKey, rows, syncedAt),
        );
      } catch (error) {
        if (
          isTransactionRestartError(error) &&
          attempt < MAX_PERSIST_ATTEMPTS
        ) {
          this.logger.warn(
            `Card provider "${providerKey}" catalogue write was rolled back by the server — restarting the transaction`,
          );
          await this.pauseBeforeRestart(attempt);
          continue;
        }

        if (error instanceof QueryFailedError) {
          this.logger.error(
            `Card provider "${providerKey}" catalogue write failed — the previous snapshot is unchanged`,
            error.stack,
          );
          throw new CardProviderCatalogueNotStoredError(providerKey, {
            cause: error,
          });
        }

        throw error;
      }
    }
  }

  /**
   * The write phase: an upsert of everything the provider listed, then a
   * withdrawal of everything it did not. This transaction contains no `SELECT`
   * at all, and that is a requirement.
   */
  private async persist(
    manager: EntityManager,
    providerKey: CardProviderKey,
    rows: CardProductRow[],
    syncedAt: Date,
  ): Promise<number> {
    if (rows.length > 0) {
      // One statement for the whole catalogue: this runs inline on a partner's
      // request whenever the snapshot is cold, so the round trips are on that
      // request's latency.
      await manager
        .createQueryBuilder()
        .insert()
        .into(CardProductEntity)
        // Cast because TypeORM's deep-partial type descends into every property
        // of every column, and the `json` column's `Record<string, unknown>` has
        // no deep-partial form. `CardProductRow` is already the entity's own
        // fields, so nothing is being widened here.
        .values(rows as QueryDeepPartialEntity<CardProductEntity>[])
        .orUpdate(Object.values(UPSERT_COLUMNS))
        .execute();
    }

    return this.withdrawAbsent(
      manager,
      providerKey,
      rows.map((row) => row.providerProductId),
      syncedAt,
    );
  }

  /**
   * How many of this run's rows the upsert actually inserted. Counted by
   * asking which of the `public_id`s *this run minted* are on a row: a
   * `public_id` is written once and never rewritten, so one that landed marks
   * a row this run created.
   */
  private async countInserted(
    providerKey: CardProviderKey,
    rows: CardProductRow[],
  ): Promise<number | null> {
    if (rows.length === 0) return 0;

    try {
      return await this.dataSource.getRepository(CardProductEntity).count({
        where: {
          providerKey,
          publicId: In(rows.map((row) => row.publicId)),
        },
      });
    } catch (error) {
      this.logger.warn(
        `Card provider "${providerKey}" catalogue was stored but its products could not be counted — reporting the counts as unknown`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }
  }

  /** Jittered pause between restarts. See `RESTART_BASE_DELAY_MS`. */
  private pauseBeforeRestart(attempt: number): Promise<void> {
    const ceiling = RESTART_BASE_DELAY_MS * attempt;
    return new Promise((resolve) =>
      setTimeout(resolve, Math.random() * ceiling),
    );
  }

  /**
   * Withdraws every row this provider had that the response did not mention,
   * and returns how many were still on offer. Never a delete — cards already
   * issued against a product still need it to describe them, and this schema
   * has no soft deletes.
   */
  private async withdrawAbsent(
    manager: EntityManager,
    providerKey: CardProviderKey,
    seenProductIds: string[],
    syncedAt: Date,
  ): Promise<number> {
    // Raw database column names rather than entity properties.
    const absent = (
      builder: UpdateQueryBuilder<CardProductEntity>,
    ): UpdateQueryBuilder<CardProductEntity> => {
      builder.where('provider_key = :providerKey', { providerKey });
      // A provider that listed nothing withdraws its whole catalogue, and
      // `NOT IN ()` is not valid SQL — the absent set is simply every row.
      if (seenProductIds.length > 0) {
        builder.andWhere('provider_product_id NOT IN (:...seenProductIds)', {
          seenProductIds,
        });
      }
      return builder;
    };

    // Already withdrawn: confirmed again, nothing to report. Run first so the
    // two statements stay disjoint — the other one moves rows into this set.
    await absent(
      manager.createQueryBuilder().update(CardProductEntity).set({ syncedAt }),
    )
      .andWhere('available_for_issuance = FALSE')
      .execute();

    const withdrawn = await absent(
      manager
        .createQueryBuilder()
        .update(CardProductEntity)
        .set({ availableForIssuance: false, syncedAt }),
    )
      .andWhere('available_for_issuance = TRUE')
      .execute();

    return withdrawn.affected ?? 0;
  }

  /**
   * The listings as rows to upsert, each carrying a freshly minted
   * `public_id`, ordered by the natural key. The order is load-bearing.
   */
  private toRows(
    providerKey: CardProviderKey,
    listings: CardProductListing[],
    syncedAt: Date,
  ): CardProductRow[] {
    const byProductId = new Map<string, CardProductRow>();

    for (const listing of listings) {
      const providerProductId = listing.product.providerProductId;
      if (byProductId.has(providerProductId)) {
        this.logger.warn(
          `Card provider "${providerKey}" listed product "${providerProductId}" more than once in one response — keeping the first and ignoring the repeat`,
        );
        continue;
      }

      byProductId.set(providerProductId, {
        publicId: randomUUID(),
        providerKey,
        providerProductId,
        ...this.toRowFields(listing, syncedAt),
      });
    }

    return [...byProductId.values()].sort((a, b) =>
      a.providerProductId < b.providerProductId
        ? -1
        : a.providerProductId > b.providerProductId
          ? 1
          : 0,
    );
  }

  private toRowFields(
    listing: CardProductListing,
    syncedAt: Date,
  ): CardProductRowFields {
    const { product, rawPayload } = listing;
    const { activation } = product;

    return {
      displayName: product.displayName,
      cardType: product.cardType,
      cardOrganisation: product.cardOrganisation,
      material: product.material,
      currencyCode: product.currencyCode,
      issuanceFeeAmount: product.fees.issuance?.amount ?? null,
      issuanceFeeCurrency: product.fees.issuance?.currencyCode ?? null,
      annualFeeAmount: product.fees.annual?.amount ?? null,
      annualFeeCurrency: product.fees.annual?.currencyCode ?? null,
      depositFeePercent: product.fees.depositFeePercent,
      depositMinPerTransaction: product.depositLimits.minPerTransaction,
      depositMaxPerTransaction: product.depositLimits.maxPerTransaction,
      depositMaxPerDay: product.depositLimits.maxPerDay,
      requiresInitialDeposit: product.depositLimits.requiresInitialDeposit,
      depositMinInitial: product.depositLimits.minInitialDeposit,
      applicationMode: product.applicationMode,
      requiresKyc: product.requiresKyc,
      activationMode: activation.mode,
      // Null on the arm that carries no such field — the flat column pair is
      // how the domain union round-trips without being able to express its
      // meaningless combination.
      activationRequiresIdentityDocument:
        activation.mode === CardProductActivationMode.ISSUER_REQUEST
          ? activation.requiresIdentityDocument
          : null,
      sensitiveDetailMode: product.sensitiveDetailMode,
      availableForIssuance: product.availableForIssuance,
      supportedOperations: [...product.supportedOperations],
      rawPayload,
      syncedAt,
    };
  }
}
