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
import { CARD_DEPOSIT_REQUEST_ID_MAX_LENGTH } from '../../domain/card-deposit-intent.model';
import { CardDepositStatus } from '../../domain/card-deposit-status.enum';
import { CardProviderKey } from '../../domain/card-provider-key.enum';
import { CardEntity } from './card.entity';

/**
 * The widths a writer has to cut a failure reason down to, declared beside the
 * columns so a migration that widens either moves one number.
 */
export const CARD_DEPOSIT_REASON_CODE_MAX_LENGTH = 40;
export const CARD_DEPOSIT_MESSAGE_MAX_LENGTH = 255;

/**
 * One attempt to put money on an already-issued card, written before the
 * issuer is called.
 */
@Entity('card_deposit')
@Index('uq_card_deposit_provider_request', ['providerKey', 'requestId'], {
  unique: true,
})
/**
 * Narrows a settlement pass to the deposits still worth asking about, and
 * carries the rotation stamp so the sort runs over that small set.
 */
@Index('idx_card_deposit_status_checked', ['status', 'statusCheckedAt'])
/**
 * Leads with `card_id`, so it satisfies the foreign key's own index
 * requirement — without it the storage engine creates a hidden one — and
 * orders a card's deposits by age, which is how they are read back.
 */
@Index('idx_card_deposit_card_created', ['cardId', 'createdAt'])
export class CardDepositEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'public_id', type: 'char', length: 36, unique: true })
  publicId!: string;

  @Column({ name: 'card_id', type: 'bigint', unsigned: true })
  cardId!: string;

  @ManyToOne(() => CardEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'card_id' })
  card?: CardEntity;

  /**
   * A copy of `card.provider_key`, kept because the unique constraint below
   * needs both halves on one row and a constraint cannot span a join.
   */
  @Column({ name: 'provider_key', type: 'varchar', length: 20 })
  providerKey!: CardProviderKey;

  /**
   * The partner's own idempotency key, unique within one issuer's namespace.
   * `UNIQUE (provider_key, request_id)` is the actual guarantee rather than an
   * app-level check, which would have a TOCTOU gap under concurrency.
   */
  @Column({
    name: 'request_id',
    type: 'varchar',
    length: CARD_DEPOSIT_REQUEST_ID_MAX_LENGTH,
    collation: 'utf8mb4_nopad_bin',
  })
  requestId!: string;

  /**
   * The reference this deposit was submitted under, and not the partner's
   * `request_id`.
   */
  @Column({ name: 'provider_reference', type: 'varchar', length: 80 })
  providerReference!: string;

  /**
   * The issuer's own id for this deposit, absent until they return one. Null
   * therefore means "not reported yet", never "this deposit has none".
   */
  @Column({
    name: 'provider_deposit_id',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  providerDepositId!: string | null;

  /** What the partner asked to land on the card, in `currency_code` below. */
  @Column({ type: 'varchar', length: 32 })
  amount!: string;

  /**
   * The currency `amount` and `credited_amount` are denominated in — the
   * card's own, which is the only currency a deposit can be made in.
   */
  @Column({ name: 'currency_code', type: 'varchar', length: 16 })
  currencyCode!: string;

  /**
   * What the issuer says actually landed, known only after settlement. A
   * different number from `amount` once their fee and exchange rate are
   * applied, which is why it is stored rather than assumed equal.
   */
  @Column({
    name: 'credited_amount',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  creditedAmount!: string | null;

  @Column({
    type: 'varchar',
    length: 24,
    default: CardDepositStatus.DRAFT,
  })
  status!: CardDepositStatus;

  /** The issuer's own failure code, or ours when the attempt never left. */
  @Column({ name: 'reason_code', type: 'varchar', length: 40, nullable: true })
  reasonCode!: string | null;

  /** Human-readable detail for the code above. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  message!: string | null;

  /**
   * The issuer's most recent raw response, retained for replay. The
   * acknowledgement first, then whatever the settlement lookup returned — the
   * later one is worth keeping, since an acknowledgement carries no outcome.
   */
  @Column({ name: 'response_payload', type: 'json', nullable: true })
  responsePayload!: Record<string, unknown> | null;

  /**
   * When the issuer was last asked what became of this deposit — not when the
   * deposit last changed. `updated_at` carries that.
   */
  @Column({
    name: 'status_checked_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  statusCheckedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;

  @BeforeInsert()
  assignPublicId(): void {
    this.publicId ??= randomUUID();
  }
}
