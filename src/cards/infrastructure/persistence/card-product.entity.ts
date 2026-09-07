import { randomUUID } from 'node:crypto';
import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CardLifecycleOperation } from '../../domain/card-lifecycle-operation.enum';
import { CardMaterial } from '../../domain/card-material.enum';
import { CardOrganisation } from '../../domain/card-organisation.enum';
import { CardProductActivationMode } from '../../domain/card-product-activation-mode.enum';
import { CardProductApplicationMode } from '../../domain/card-product-application-mode.enum';
import { CardProductSensitiveDetailMode } from '../../domain/card-product-sensitive-detail-mode.enum';
import { CardProviderKey } from '../../domain/card-provider-key.enum';
import { CardType } from '../../domain/card-type.enum';

/**
 * A provider's card product, persisted as an identity map rather than a cache
 * — a partner refers to a product by our `public_id`, and that id has to
 * survive a refresh, a redeploy, and the provider adding a product.
 */
@Entity('card_product')
@Index('uq_card_product_provider', ['providerKey', 'providerProductId'], {
  unique: true,
})
export class CardProductEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'public_id', type: 'char', length: 36, unique: true })
  publicId!: string;

  @Column({ name: 'provider_key', type: 'varchar', length: 20 })
  providerKey!: CardProviderKey;

  /** The provider's own stable handle for this product — never returned through the API. */
  @Column({ name: 'provider_product_id', type: 'varchar', length: 80 })
  providerProductId!: string;

  /**
   * A human-readable name for the product. Composed by the adapter for an
   * issuer that publishes no name field of its own — see the comment on
   * `CardProduct.displayName`.
   */
  @Column({ name: 'display_name', type: 'varchar', length: 150 })
  displayName!: string;

  @Column({ name: 'card_type', type: 'varchar', length: 20 })
  cardType!: CardType;

  @Column({ name: 'card_organisation', type: 'varchar', length: 20 })
  cardOrganisation!: CardOrganisation;

  /**
   * Null only when the issuer publishes no material for the product — never
   * a stand-in for "this one is virtual". See `CardProduct.material`.
   */
  @Column({ type: 'varchar', length: 20, nullable: true })
  material!: CardMaterial | null;

  /**
   * The card's own currency — fiat, and never a coin ticker. This comment used
   * to claim the opposite, and the claim caused a real defect: a change
   * concluded a product could be denominated in `USDT` and widened
   * `card.currency` to match.
   */
  @Column({ name: 'currency_code', type: 'varchar', length: 16 })
  currencyCode!: string;

  /**
   * Fee and deposit-limit amounts below are `varchar` decimal strings, not
   * `DECIMAL(18,2)` — a deliberate deviation from this codebase's money rule.
   */
  @Column({
    name: 'issuance_fee_amount',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  issuanceFeeAmount!: string | null;

  @Column({
    name: 'issuance_fee_currency',
    type: 'varchar',
    length: 16,
    nullable: true,
  })
  issuanceFeeCurrency!: string | null;

  @Column({
    name: 'annual_fee_amount',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  annualFeeAmount!: string | null;

  @Column({
    name: 'annual_fee_currency',
    type: 'varchar',
    length: 16,
    nullable: true,
  })
  annualFeeCurrency!: string | null;

  /** Percent units — `'2.800'` means 2.8%. Null when depositing is free. */
  @Column({
    name: 'deposit_fee_percent',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  depositFeePercent!: string | null;

  @Column({
    name: 'deposit_min_per_transaction',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  depositMinPerTransaction!: string | null;

  @Column({
    name: 'deposit_max_per_transaction',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  depositMaxPerTransaction!: string | null;

  @Column({
    name: 'deposit_max_per_day',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  depositMaxPerDay!: string | null;

  @Column({ name: 'requires_initial_deposit', type: 'boolean' })
  requiresInitialDeposit!: boolean;

  @Column({
    name: 'deposit_min_initial',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  depositMinInitial!: string | null;

  @Column({ name: 'application_mode', type: 'varchar', length: 32 })
  applicationMode!: CardProductApplicationMode;

  @Column({ name: 'requires_kyc', type: 'boolean' })
  requiresKyc!: boolean;

  @Column({ name: 'activation_mode', type: 'varchar', length: 20 })
  activationMode!: CardProductActivationMode;

  /**
   * Only meaningful on the `ISSUER_REQUEST` activation mode — null is how
   * `CardActivation`'s other arm (`CARDHOLDER_DIRECT`, which carries no such
   * field) round-trips through a flat column pair.
   */
  @Column({
    name: 'activation_requires_identity_document',
    type: 'boolean',
    nullable: true,
  })
  activationRequiresIdentityDocument!: boolean | null;

  /**
   * How a card issued against this product yields its number, security code
   * and expiry. `NULL` when the issuer publishes nothing this codebase can
   * place — see `CardProduct.sensitiveDetailMode`.
   */
  @Column({
    name: 'sensitive_detail_mode',
    type: 'varchar',
    length: 24,
    nullable: true,
  })
  sensitiveDetailMode!: CardProductSensitiveDetailMode | null;

  /**
   * No column default, deliberately: the catalogue sync must always state
   * this explicitly, and a default would hide a mapper that forgot to.
   */
  @Column({ name: 'available_for_issuance', type: 'boolean' })
  availableForIssuance!: boolean;

  /**
   * Which operations the issuer offers against a card issued against this
   * product. An issuer publishing none stores `[]`; the column is `NOT NULL`
   * so that cannot be confused with "not known".
   */
  @Column({ name: 'supported_operations', type: 'json' })
  supportedOperations!: CardLifecycleOperation[];

  /**
   * The provider's raw response for this product, retained for replay. Their
   * page warns they add fields over time, so the normaliser drops data by
   * design and this is where it survives.
   */
  @Column({ name: 'raw_payload', type: 'json' })
  rawPayload!: Record<string, unknown>;

  /**
   * When this row was last confirmed against the provider. `updatedAt` cannot
   * be used instead, for two reasons.
   */
  @Column({ name: 'synced_at', type: 'datetime', precision: 6 })
  syncedAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;

  @BeforeInsert()
  assignPublicId(): void {
    this.publicId ??= randomUUID();
  }
}
