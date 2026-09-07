import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsSelect, Repository } from 'typeorm';
import {
  CardProductListResponseDto,
  CardProductResponseDto,
} from '../api/dto/card-product-response.dto';
import { CardCapability } from '../domain/card-capability.enum';
import { CardCatalogueRefreshFailedError } from '../domain/card-catalogue-refresh-failed.error';
import { CardProductActivationMode } from '../domain/card-product-activation-mode.enum';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardProductEntity } from '../infrastructure/persistence/card-product.entity';
import { assertCardCapability } from './assert-card-capability';
import { SyncCardProductsUseCase } from './sync-card-products.usecase';

export interface ListCardProductsInput {
  providerKey: CardProviderKey;
  includeUnavailable: boolean;
}

/** How long a failed refresh suppresses the next one. */
const FAILED_REFRESH_BACKOFF_MS = 60_000;

/** The columns a partner-facing response is projected from. */
const RESPONSE_COLUMNS: FindOptionsSelect<CardProductEntity> = {
  publicId: true,
  displayName: true,
  cardType: true,
  cardOrganisation: true,
  material: true,
  currencyCode: true,
  issuanceFeeAmount: true,
  issuanceFeeCurrency: true,
  annualFeeAmount: true,
  annualFeeCurrency: true,
  depositFeePercent: true,
  depositMinPerTransaction: true,
  depositMaxPerTransaction: true,
  depositMaxPerDay: true,
  requiresInitialDeposit: true,
  depositMinInitial: true,
  applicationMode: true,
  requiresKyc: true,
  activationMode: true,
  activationRequiresIdentityDocument: true,
  sensitiveDetailMode: true,
  availableForIssuance: true,
  supportedOperations: true,
  syncedAt: true,
};

/**
 * What this process knows about refreshing one provider's catalogue, beyond
 * what the table records.
 */
interface CatalogueRefreshState {
  /**
   * When a refresh last completed without throwing. Tracked separately from
   * any row's `synced_at` because a successful refresh that writes no rows is
   * still a confirmation.
   */
  confirmedAt: Date | null;
  /** When a refresh last failed. Suppresses retries for the backoff above. */
  failedAt: Date | null;
  /**
   * The refresh currently running, so concurrent requests share one provider
   * call instead of each firing their own and racing each other's writes.
   */
  inFlight: Promise<void> | null;
}

/**
 * Serves a provider's card catalogue to a partner, from the persisted
 * snapshot. The provider is not called on a warm snapshot — only when the
 * snapshot is unconfirmed or past its window, no refresh has just failed, and
 * none is in flight.
 */
@Injectable()
export class ListCardProductsUseCase {
  private readonly logger = new Logger(ListCardProductsUseCase.name);

  private readonly refreshStates = new Map<
    CardProviderKey,
    CatalogueRefreshState
  >();

  constructor(
    @InjectRepository(CardProductEntity)
    private readonly cardProductRepository: Repository<CardProductEntity>,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
    // The only use case in this codebase that injects another. The alternative
    // was a third class wrapping the sync, or duplicating its transaction and
    // race handling here — both worse. Same layer, so no boundary is crossed.
    private readonly syncCardProductsUseCase: SyncCardProductsUseCase,
    private readonly configService: ConfigService,
  ) {}

  async execute(
    input: ListCardProductsInput,
  ): Promise<CardProductListResponseDto> {
    const { providerKey, includeUnavailable } = input;

    // `resolve` throws 400 for a valid-but-disabled provider key.
    const adapter = this.cardIssuerRegistry.resolve(providerKey);
    assertCardCapability(
      adapter,
      CardCapability.PRODUCT_CATALOGUE,
      providerKey,
      'a product catalogue',
    );

    const state = this.refreshStateFor(providerKey);
    let rows = await this.findAll(providerKey);
    let snapshotAt = this.newestSyncedAt(rows);

    if (this.needsRefresh(state, snapshotAt)) {
      try {
        await this.refreshOnce(providerKey, state);
        rows = await this.findAll(providerKey);
        snapshotAt = this.newestSyncedAt(rows);
      } catch (error) {
        // Every refresh failure this codebase can name degrades the same way,
        // whether the provider could not be read or its answer could not be
        // stored. Anything unnamed is a bug of ours and escapes — catching it
        // here would report it as a stale catalogue and nowhere else.
        if (!(error instanceof CardCatalogueRefreshFailedError)) throw error;

        this.logger.warn(
          `Card provider "${providerKey}" catalogue refresh failed (${error.name}) — serving the snapshot from ${snapshotAt?.toISOString() ?? 'an unknown time'}`,
        );
      }
    }

    // Nothing has ever been confirmed and nothing is stored: an empty list
    // here would assert "this provider offers no products", which is a
    // different and false claim from "we could not find out".
    if (
      rows.length === 0 &&
      snapshotAt === null &&
      state.confirmedAt === null
    ) {
      throw new ServiceUnavailableException(
        `Card provider "${providerKey}" catalogue is unavailable`,
      );
    }

    const items = includeUnavailable
      ? rows
      : rows.filter((row) => row.availableForIssuance);

    return {
      providerKey,
      syncedAt: snapshotAt,
      items: items.map((row) => this.toCardProductResponse(row, providerKey)),
    };
  }

  private refreshStateFor(providerKey: CardProviderKey): CatalogueRefreshState {
    let state = this.refreshStates.get(providerKey);
    if (!state) {
      state = { confirmedAt: null, failedAt: null, inFlight: null };
      this.refreshStates.set(providerKey, state);
    }
    return state;
  }

  /** Whether this request should call the provider. */
  private needsRefresh(
    state: CatalogueRefreshState,
    snapshotAt: Date | null,
  ): boolean {
    // Whatever is stored is served as-is when the read path is not allowed to
    // refresh. A refresh withdraws every stored row the provider's live
    // listing omits, so under test — where one schema is shared by an
    // application per spec file — it withdraws the products other specs
    // seeded. A spec that means to exercise the refresh turns this back on.
    if (
      !this.configService.getOrThrow<boolean>(
        'CARD_PRODUCT_CATALOGUE_REFRESH_ON_READ',
      )
    ) {
      return false;
    }

    const ttlMs =
      this.configService.getOrThrow<number>(
        'CARD_PRODUCT_CATALOGUE_TTL_SECONDS',
      ) * 1000;

    // The newer of "a row says it was confirmed then" and "a refresh completed
    // then". The second is what covers a provider with no products at all.
    const confirmedAt = this.laterOf(snapshotAt, state.confirmedAt);
    if (confirmedAt !== null && Date.now() - confirmedAt.getTime() <= ttlMs) {
      return false;
    }

    if (
      state.failedAt !== null &&
      Date.now() - state.failedAt.getTime() < FAILED_REFRESH_BACKOFF_MS
    ) {
      return false;
    }

    return true;
  }

  /**
   * Runs one refresh per provider at a time, so a burst of requests on a cold
   * snapshot produces one provider call rather than one each — and does not
   * have them race each other into the sync's duplicate-key restart path.
   */
  private refreshOnce(
    providerKey: CardProviderKey,
    state: CatalogueRefreshState,
  ): Promise<void> {
    if (state.inFlight) return state.inFlight;

    const attempt = this.syncCardProductsUseCase
      .execute(providerKey)
      .then(() => {
        // A refresh that wrote no rows still confirms the catalogue.
        state.confirmedAt = new Date();
        state.failedAt = null;
      })
      .catch((error: unknown) => {
        state.failedAt = new Date();
        throw error;
      })
      .finally(() => {
        state.inFlight = null;
      });

    state.inFlight = attempt;
    return attempt;
  }

  /**
   * Every row the provider owns, withdrawn ones included. The staleness
   * decision has to see them: a sync moves `synced_at` on a withdrawn row too,
   * precisely so a catalogue whose products have all been withdrawn does not
   * read as permanently cold.
   */
  private findAll(providerKey: CardProviderKey): Promise<CardProductEntity[]> {
    return this.cardProductRepository.find({
      where: { providerKey },
      select: RESPONSE_COLUMNS,
      order: { displayName: 'ASC', publicId: 'ASC' },
    });
  }

  private newestSyncedAt(rows: CardProductEntity[]): Date | null {
    return rows.reduce<Date | null>(
      (newest, row) => this.laterOf(newest, row.syncedAt),
      null,
    );
  }

  private laterOf(a: Date | null, b: Date | null): Date | null {
    if (a === null) return b;
    if (b === null) return a;
    return a.getTime() >= b.getTime() ? a : b;
  }

  private toCardProductResponse(
    row: CardProductEntity,
    providerKey: CardProviderKey,
  ): CardProductResponseDto {
    return {
      publicId: row.publicId,
      displayName: row.displayName,
      cardType: row.cardType,
      cardOrganisation: row.cardOrganisation,
      material: row.material,
      currencyCode: row.currencyCode,
      fees: {
        issuance: this.toFee(
          row.issuanceFeeAmount,
          row.issuanceFeeCurrency,
          'issuance',
          row,
          providerKey,
        ),
        annual: this.toFee(
          row.annualFeeAmount,
          row.annualFeeCurrency,
          'annual',
          row,
          providerKey,
        ),
        depositFeePercent: row.depositFeePercent,
      },
      depositLimits: {
        minPerTransaction: row.depositMinPerTransaction,
        maxPerTransaction: row.depositMaxPerTransaction,
        maxPerDay: row.depositMaxPerDay,
        requiresInitialDeposit: row.requiresInitialDeposit,
        minInitialDeposit: row.depositMinInitial,
      },
      applicationMode: row.applicationMode,
      requiresKyc: row.requiresKyc,
      activation: {
        mode: row.activationMode,
        // The flat column pair is how the domain union round-trips. Only the
        // `ISSUER_REQUEST` arm carries the flag; the other has no activation
        // call for a document to ride on, so null rather than false.
        requiresIdentityDocument:
          row.activationMode === CardProductActivationMode.ISSUER_REQUEST
            ? row.activationRequiresIdentityDocument
            : null,
      },
      sensitiveDetailMode: row.sensitiveDetailMode,
      availableForIssuance: row.availableForIssuance,
      supportedOperations: row.supportedOperations,
    };
  }

  /**
   * A fee is only reportable when both halves are present — an amount with no
   * currency does not say what the product costs. The sync writes the pair
   * together, so a half-populated row should be unreachable.
   */
  private toFee(
    amount: string | null,
    currencyCode: string | null,
    label: string,
    row: CardProductEntity,
    providerKey: CardProviderKey,
  ): { amount: string; currencyCode: string } | null {
    if (amount !== null && currencyCode !== null)
      return { amount, currencyCode };

    if (amount !== null || currencyCode !== null) {
      this.logger.warn(
        `Card provider "${providerKey}" product ${row.publicId} has a half-populated ${label} fee (amount=${amount ?? 'null'}, currency=${currencyCode ?? 'null'}) — reporting no ${label} fee`,
      );
    }

    return null;
  }
}
