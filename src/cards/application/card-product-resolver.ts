import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsSelect, In, Repository } from 'typeorm';
import { CardCapability } from '../domain/card-capability.enum';
import { supportsCapability } from '../domain/card-issuer-guards';
import { CardLifecycleOperation } from '../domain/card-lifecycle-operation.enum';
import { CardProductApplicationMode } from '../domain/card-product-application-mode.enum';
import { CardProductFee } from '../domain/card-product.model';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardType } from '../domain/card-type.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardApplicationEntity } from '../infrastructure/persistence/card-application.entity';
import { CardProductEntity } from '../infrastructure/persistence/card-product.entity';

/** The name of the request field a partner supplies this reference in. */
export const CARD_PRODUCT_REFERENCE_FIELD = 'cardProductPublicId';

export interface ResolveCardProductInput {
  providerKey: CardProviderKey;
  /** The partner-supplied product reference. */
  cardProductPublicId: string | null | undefined;
}

/**
 * The projection an issuance path can act on — never the full row.
 * `rawPayload` is never read here: the largest column in the row, and it
 * exists only for replay.
 */
export interface ResolvedCardProduct {
  /**
   * The catalogue row's internal id, for a caller that has to record which
   * product an application named. The one place a raw `id` is legitimate: it
   * never leaves the application layer, and a foreign key cannot be written
   * from a `public_id`.
   */
  id: string;
  publicId: string;
  providerKey: CardProviderKey;
  providerProductId: string;
  applicationMode: CardProductApplicationMode;
  cardType: CardType;
  currencyCode: string;
  /**
   * Whether this product cannot be opened without an opening deposit. Separate
   * from the minimum below because an issuer can mandate a deposit while
   * stating no minimum for it.
   */
  requiresInitialDeposit: boolean;
  /** The mandated minimum, as a decimal string, when the issuer states one. */
  depositMinInitial: string | null;
  /** Not necessarily billed in the card's currency. Null when there is none. */
  issuanceFee: CardProductFee | null;
}

/** The product a card was already opened under, for the paths that add money to it. */
export interface CardDepositProduct {
  publicId: string;
  providerProductId: string;
  currencyCode: string;
  /**
   * Decimal strings, never a JS `number`. **No daily cap here** — that one needs
   * a rolling sum in the issuer's timezone and is theirs to apply.
   */
  depositMinPerTransaction: string | null;
  depositMaxPerTransaction: string | null;
}

/**
 * Every column this resolver reads: the ones it returns, plus
 * `availableForIssuance`, which only the guards consult. Named explicitly so
 * the query stays narrow.
 */
const RESOLVED_COLUMNS: FindOptionsSelect<CardProductEntity> = {
  id: true,
  publicId: true,
  providerKey: true,
  providerProductId: true,
  applicationMode: true,
  cardType: true,
  currencyCode: true,
  requiresInitialDeposit: true,
  depositMinInitial: true,
  issuanceFeeAmount: true,
  issuanceFeeCurrency: true,
  availableForIssuance: true,
};

/** Everything the operations lookup below reads. Same rule: never `rawPayload`. */
const OPERATION_COLUMNS: FindOptionsSelect<CardProductEntity> = {
  id: true,
  supportedOperations: true,
};

/** Everything `resolveForCard` reads — `providerKey` is checked, not returned. */
const DEPOSIT_COLUMNS: FindOptionsSelect<CardProductEntity> = {
  publicId: true,
  providerKey: true,
  providerProductId: true,
  currencyCode: true,
  depositMinPerTransaction: true,
  depositMaxPerTransaction: true,
};

/**
 * The reference a partner actually supplied, or `null` for the several ways of
 * supplying none. All three non-values collapse to one before anything
 * branches on them.
 */
const suppliedReference = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Turns a partner's `public_id` into the product an issuance path needs, with
 * every rejection rule in one place. This resolves against the stored
 * catalogue and never calls the provider.
 */
@Injectable()
export class CardProductResolver {
  private readonly logger = new Logger(CardProductResolver.name);

  constructor(
    @InjectRepository(CardProductEntity)
    private readonly cardProductRepository: Repository<CardProductEntity>,
    @InjectRepository(CardApplicationEntity)
    private readonly applicationRepository: Repository<CardApplicationEntity>,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
  ) {}

  /**
   * Returns `null` exactly when there is nothing to resolve: the provider has
   * no product catalogue and the partner supplied no reference. Every other
   * outcome is either the resolved product or a typed rejection.
   */
  async resolve(
    input: ResolveCardProductInput,
  ): Promise<ResolvedCardProduct | null> {
    const { providerKey } = input;
    const reference = suppliedReference(input.cardProductPublicId);

    // Throws 400 for a valid-but-disabled provider key.
    const adapter = this.cardIssuerRegistry.resolve(providerKey);
    const hasCatalogue = supportsCapability(
      adapter,
      CardCapability.PRODUCT_CATALOGUE,
    );

    if (!hasCatalogue) {
      if (reference !== null) {
        // Not `assertCardCapability`: that helper refuses an operation with a
        // 403.
        throw new BadRequestException(
          `Card provider "${providerKey}" does not support a product catalogue — ${CARD_PRODUCT_REFERENCE_FIELD} must not be supplied`,
        );
      }
      return null;
    }

    if (reference === null) {
      throw new BadRequestException(
        `Card provider "${providerKey}" requires a product reference — ${CARD_PRODUCT_REFERENCE_FIELD} is missing`,
      );
    }

    // Looked up by publicId alone, not scoped to providerKey: scoping the
    // query would collapse "this product belongs to a different provider" into
    // an indistinguishable 404, losing the rule below that names the mismatch
    // instead.
    const row = await this.cardProductRepository.findOne({
      where: { publicId: reference },
      select: RESOLVED_COLUMNS,
    });

    if (!row) {
      throw new NotFoundException('Card product not found');
    }

    if (row.providerKey !== providerKey) {
      throw new BadRequestException(
        `Card product "${reference}" belongs to provider "${row.providerKey}", not "${providerKey}"`,
      );
    }

    this.assertAvailableForIssuance(row, reference);

    return this.project(row);
  }

  /**
   * The same product from its `public_id` alone, the row naming its own
   * provider. **Does not resolve that provider**, unlike `resolve` above — the
   * projection carries the key, and a caller needing the adapter resolves it.
   */
  async resolveByPublicId(
    cardProductPublicId: string,
  ): Promise<ResolvedCardProduct> {
    const reference = suppliedReference(cardProductPublicId);
    if (reference === null) {
      throw new BadRequestException(
        `A product reference is required — ${CARD_PRODUCT_REFERENCE_FIELD} is missing`,
      );
    }

    const row = await this.cardProductRepository.findOne({
      where: { publicId: reference },
      select: RESOLVED_COLUMNS,
    });

    if (!row) {
      throw new NotFoundException('Card product not found');
    }

    this.assertAvailableForIssuance(row, reference);

    return this.project(row);
  }

  /**
   * The product a card was opened under, reached through the application row —
   * `card` carries no product reference. Null when it cannot be reached.
   *
   * **A withdrawn product is returned rather than refused**, unlike every rule
   * above: a card issued against one still exists and still takes money.
   */
  async resolveForCard(
    cardId: string,
    providerKey: CardProviderKey,
  ): Promise<CardDepositProduct | null> {
    const application = await this.applicationRepository.findOne({
      where: { cardId },
      relations: { cardProduct: true },
      select: { id: true, cardProduct: DEPOSIT_COLUMNS },
    });

    const row = application?.cardProduct;
    if (!row) return null;

    if (row.providerKey !== providerKey) {
      // The handle below is sent to an issuer as one of their own product ids.
      this.logger.error(
        `Card ${cardId} is issued by ${providerKey} but its application names a ${row.providerKey} product — refusing to price against another provider's catalogue`,
      );
      return null;
    }

    return {
      publicId: row.publicId,
      providerProductId: row.providerProductId,
      currencyCode: row.currencyCode,
      depositMinPerTransaction: row.depositMinPerTransaction,
      depositMaxPerTransaction: row.depositMaxPerTransaction,
    };
  }

  /** Refuses a product the issuer will no longer accept applications for. */
  private assertAvailableForIssuance(
    row: CardProductEntity,
    reference: string,
  ): void {
    if (row.availableForIssuance) return;

    throw new ConflictException(
      `Card product "${reference}" is not available for issuance`,
    );
  }

  private project(row: CardProductEntity): ResolvedCardProduct {
    const feeAmount = row.issuanceFeeAmount;
    const feeCurrency = row.issuanceFeeCurrency;

    return {
      id: row.id,
      publicId: row.publicId,
      providerKey: row.providerKey,
      providerProductId: row.providerProductId,
      applicationMode: row.applicationMode,
      cardType: row.cardType,
      currencyCode: row.currencyCode,
      requiresInitialDeposit: row.requiresInitialDeposit,
      depositMinInitial: row.depositMinInitial,
      // Both halves or neither: an amount with no currency would reach an addition.
      issuanceFee:
        feeAmount && feeCurrency
          ? { amount: feeAmount, currencyCode: feeCurrency.toUpperCase() }
          : null,
    };
  }

  /**
   * What each of these products publishes it accepts, keyed by internal id.
   *
   * **Reads the stored catalogue directly, never through the catalogue read
   * use-case**, which refreshes a stale snapshot by calling the issuer — a
   * card read must not fail because a provider is unreachable.
   *
   * A withdrawn product is not filtered out: a card issued against one still
   * exists and still accepts what the issuer offers against it.
   */
  async supportedOperationsByProductId(
    productIds: readonly string[],
  ): Promise<Map<string, readonly CardLifecycleOperation[]>> {
    if (productIds.length === 0) return new Map();

    const rows = await this.cardProductRepository.find({
      where: { id: In([...productIds]) },
      select: OPERATION_COLUMNS,
    });

    return new Map(rows.map((row) => [row.id, row.supportedOperations]));
  }
}
