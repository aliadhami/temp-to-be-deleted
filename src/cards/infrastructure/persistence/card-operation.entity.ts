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
import { CardLifecycleOperation } from '../../domain/card-lifecycle-operation.enum';
import {
  CardOperationStatus,
  IN_FLIGHT_CARD_OPERATION_STATUSES,
} from '../../domain/card-operation-status.enum';
import { CardProviderKey } from '../../domain/card-provider-key.enum';
import { CardEntity } from './card.entity';

/**
 * The widths a writer has to cut a failure reason down to, declared beside the
 * columns so a migration that widens either moves one number.
 */
export const CARD_OPERATION_REASON_CODE_MAX_LENGTH = 40;
export const CARD_OPERATION_MESSAGE_MAX_LENGTH = 255;

/** Wide enough for a canonical UUID, which is the only thing ever stored here. */
export const CARD_OPERATION_REQUEST_REFERENCE_MAX_LENGTH = 36;

/** The index a duplicate-key error names when a card already has one in flight. */
export const CARD_OPERATION_IN_FLIGHT_INDEX = 'uq_card_operation_in_flight';

/**
 * `card_id` while the operation holds the card, `NULL` once it does not, so an
 * ordinary `UNIQUE` index over it is the whole single-in-flight guarantee —
 * no read before the write, and no TOCTOU gap under concurrency. The migration
 * carries the same text as a literal, and `schema:log` proves the two agree.
 */
export const CARD_OPERATION_IN_FLIGHT_EXPRESSION = `IF(\`status\` IN (${IN_FLIGHT_CARD_OPERATION_STATUSES.map(
  (status) => `'${status}'`,
).join(', ')}), \`card_id\`, NULL)`;

/**
 * One operation requested against a card that already exists, written before
 * the issuer is called. It exists because the `card` row cannot answer "was
 * this ever asked for?" — an issuer that only acknowledges the request applies
 * it hours later, and until then the card looks untouched.
 */
@Entity('card_operation')
@Index(
  'uq_card_operation_provider_reference',
  ['providerKey', 'requestReference'],
  {
    unique: true,
  },
)
/**
 * Narrows a reconcile pass to the operations still worth asking about, and
 * carries the rotation stamp so the sort runs over that small set.
 */
@Index('idx_card_operation_status_checked', ['status', 'statusCheckedAt'])
/**
 * Leads with `card_id`, so it satisfies the foreign key's own index
 * requirement — without it the storage engine creates a hidden one — and
 * orders a card's operations by age, which is how the one in flight is found.
 */
@Index('idx_card_operation_card_created', ['cardId', 'createdAt'])
export class CardOperationEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  // No `public_id`: no route addresses an operation. Its whole outcome is the
  // card's status, which the card reads already publish.

  @Column({ name: 'card_id', type: 'bigint', unsigned: true })
  cardId!: string;

  @ManyToOne(() => CardEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'card_id' })
  card?: CardEntity;

  /**
   * A copy of `card.provider_key`, kept because the unique constraint below
   * needs both halves on one row and a constraint cannot span a join. The
   * write reads it from the card, never from a caller.
   */
  @Column({ name: 'provider_key', type: 'varchar', length: 20 })
  providerKey!: CardProviderKey;

  /**
   * The reference this operation is submitted under and looked up by — a
   * canonical UUID, reshaped into whatever form an issuer's own field wants
   * inside that issuer's adapter. **Never exposed, so not a `public_id`**, and
   * minted per operation rather than taken from the card, which is operated on
   * repeatedly.
   *
   * **`varchar`, never `char`** — a `char` is right-padded on storage, which
   * collapses two references differing only in trailing space into one row and
   * so defeats the whole reason for the collation.
   */
  @Column({
    name: 'request_reference',
    type: 'varchar',
    length: CARD_OPERATION_REQUEST_REFERENCE_MAX_LENGTH,
    collation: 'utf8mb4_nopad_bin',
  })
  requestReference!: string;

  /**
   * What was asked for, in this codebase's vocabulary. An issuer's own code is
   * derived from it inside that issuer's adapter and never stored.
   */
  @Column({ name: 'operation_type', type: 'varchar', length: 20 })
  operationType!: CardLifecycleOperation;

  @Column({
    type: 'varchar',
    length: 24,
    default: CardOperationStatus.DRAFT,
  })
  status!: CardOperationStatus;

  /**
   * Server-generated; never written and never read by application code. It
   * exists only to carry the unique index above it.
   */
  @Column({
    name: 'in_flight_card_id',
    type: 'bigint',
    unsigned: true,
    nullable: true,
    asExpression: CARD_OPERATION_IN_FLIGHT_EXPRESSION,
    generatedType: 'VIRTUAL',
  })
  @Index(CARD_OPERATION_IN_FLIGHT_INDEX, { unique: true })
  inFlightCardId!: string | null;

  /** The issuer's own failure code, or ours when the request never left. */
  @Column({
    name: 'reason_code',
    type: 'varchar',
    length: CARD_OPERATION_REASON_CODE_MAX_LENGTH,
    nullable: true,
  })
  reasonCode!: string | null;

  /** Human-readable detail for the code above. */
  @Column({
    type: 'varchar',
    length: CARD_OPERATION_MESSAGE_MAX_LENGTH,
    nullable: true,
  })
  message!: string | null;

  /**
   * The issuer's most recent raw response, retained for replay. The
   * acknowledgement first, then whatever the result lookup returned — the
   * later one is worth keeping, since an acknowledgement carries no outcome.
   */
  @Column({ name: 'response_payload', type: 'json', nullable: true })
  responsePayload!: Record<string, unknown> | null;

  /**
   * When the issuer was last asked what became of this operation — not when
   * the operation last changed. `updated_at` carries that.
   */
  @Column({
    name: 'status_checked_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  statusCheckedAt!: Date | null;

  /**
   * Set once, the first time an operation is found to have outlived the time
   * an issuer is given to answer — a column rather than a warning per pass,
   * since the condition lasts days.
   */
  @Column({
    name: 'escalated_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  escalatedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;

  @BeforeInsert()
  assignRequestReference(): void {
    this.requestReference ??= randomUUID();
  }
}
