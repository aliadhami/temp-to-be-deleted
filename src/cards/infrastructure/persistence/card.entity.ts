import { randomUUID } from 'node:crypto';
import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { PartnerEntity } from '../../../partners/persistence/partner.entity';
import { CardActivationStatus } from '../../domain/card-activation-status.enum';
import { CardProviderKey } from '../../domain/card-provider-key.enum';
import { CardStatus } from '../../domain/card-status.enum';
import { CardType } from '../../domain/card-type.enum';
import { CardholderEntity } from './cardholder.entity';

@Entity('card')
@Index('idx_card_partner', ['partnerId'])
@Index('idx_card_cardholder', ['cardholderId'])
/**
 * The status index carries the check timestamp as its second column, so the
 * sweeps that read least-recently-checked-first get their ordering from the
 * index rather than a sort.
 */
@Index('idx_card_status_checked', ['status', 'statusCheckedAt'])
@Index('idx_card_activation_checked', [
  'status',
  'activationStatus',
  'statusCheckedAt',
])
@Index('uq_card_provider', ['providerKey', 'providerCardId'], {
  unique: true,
  where: '`provider_card_id` IS NOT NULL',
})
export class CardEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'public_id', type: 'char', length: 36, unique: true })
  publicId!: string;

  @Column({ name: 'partner_id', type: 'bigint', unsigned: true })
  partnerId!: string;

  @ManyToOne(() => PartnerEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'partner_id' })
  partner?: PartnerEntity;

  @Column({ name: 'cardholder_id', type: 'bigint', unsigned: true })
  cardholderId!: string;

  @ManyToOne(() => CardholderEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'cardholder_id' })
  cardholder?: CardholderEntity;

  @Column({ name: 'provider_key', type: 'varchar', length: 20 })
  providerKey!: CardProviderKey;

  /** The provider's own card id — null until issuance succeeds. */
  @Column({
    name: 'provider_card_id',
    type: 'varchar',
    length: 80,
    nullable: true,
  })
  providerCardId!: string | null;

  @Column({ name: 'card_type', type: 'varchar', length: 20 })
  cardType!: CardType;

  @Column({ name: 'name_on_card', type: 'varchar', length: 150 })
  nameOnCard!: string;

  /**
   * The currency the card is denominated in, and it is always fiat — three
   * characters is the right width, not an oversight.
   */
  @Column({ type: 'varchar', length: 3, default: 'USD' })
  currency!: string;

  @Column({ type: 'varchar', length: 20, default: CardStatus.NOT_ACTIVATED })
  status!: CardStatus;

  @Column({ name: 'masked_pan', type: 'varchar', length: 20, nullable: true })
  maskedPan!: string | null;

  /**
   * Whether an activation attempt is outstanding, for an issuer that accepts
   * an activation and settles it afterwards. Null means none is — either none
   * was ever made, or the card is already active. `status` cannot answer this:
   * a card mid-activation is still `NOT_ACTIVATED`.
   */
  @Column({
    name: 'activation_status',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  activationStatus!: CardActivationStatus | null;

  /**
   * The issuer's own code and words for a refused activation — the actionable
   * half, since their codes name what is wrong with the photograph. Held here
   * rather than read across from `card_application` so both card reads project
   * one row; an application's fault is about the attempt to open the card,
   * this is about the attempt to activate it. Both are cleared when a fresh
   * attempt is accepted and when the card reaches active.
   */
  @Column({
    name: 'activation_reason_code',
    type: 'varchar',
    length: 40,
    nullable: true,
  })
  activationReasonCode!: string | null;

  @Column({
    name: 'activation_reason',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  activationReason!: string | null;

  /**
   * Balance snapshot from the last reconcile pass — **a decimal string in the
   * card's own currency units**, exactly as the issuer published it, and never
   * a JS `number` and never integer minor units. An issuer's currency appendix
   * lists currencies whose minor-unit exponent is not two, and four with none
   * at all, so no constant conversion exists.
   */
  @Column({
    name: 'balance_available',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  balanceAvailable!: string | null;

  @Column({
    name: 'balance_ledger',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  balanceLedger!: string | null;

  @Column({
    name: 'balance_currency',
    type: 'varchar',
    length: 3,
    nullable: true,
  })
  balanceCurrency!: string | null;

  /**
   * The observation at which the figures above were last seen to change —
   * *not* when they were last read. The distinction is easy to get backwards.
   */
  @Column({
    name: 'balance_observed_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  balanceObservedAt!: Date | null;

  /**
   * When an issuer was last asked about this card — not when anything about it
   * changed. `updated_at` and the `card_event` rows carry that.
   */
  @Column({
    name: 'status_checked_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  statusCheckedAt!: Date | null;

  @Column({ name: 'response_payload', type: 'json', nullable: true })
  responsePayload!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;

  @BeforeInsert()
  assignPublicId(): void {
    this.publicId ??= randomUUID();
  }
}
