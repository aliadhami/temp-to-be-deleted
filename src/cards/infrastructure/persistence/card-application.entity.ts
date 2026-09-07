import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CardApplicationStatus } from '../../domain/card-application-status.enum';
import { CardProviderKey } from '../../domain/card-provider-key.enum';
import { CardProductEntity } from './card-product.entity';
import { CardEntity } from './card.entity';

/**
 * The widths a writer has to cut a failure reason down to, declared beside the
 * columns so a migration that widens either moves one number. Both paths that
 * record an outcome truncate here rather than letting the server do it.
 */
export const CARD_APPLICATION_REASON_CODE_MAX_LENGTH = 40;
export const CARD_APPLICATION_MESSAGE_MAX_LENGTH = 255;

/**
 * One attempt to open a card account at an issuer, written before the issuer
 * is called. It exists because the `card` row cannot answer "was this ever
 * sent?".
 */
@Entity('card_application')
@Index('uq_card_application_provider_request', ['providerKey', 'requestId'], {
  unique: true,
})
@Index('uq_card_application_card', ['cardId'], { unique: true })
@Index('idx_card_application_status_checked', ['status', 'statusCheckedAt'])
export class CardApplicationEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  /**
   * `UNIQUE`, because "was this card's application ever sent?" has to have one
   * answer. Without it a card could carry both a `SUBMISSION_FAILED` row and a
   * `SUBMITTED` one, and a reader would get whichever the database returned
   * first.
   */
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
   * Our own reference for this attempt, unique within one issuer's namespace —
   * sent with the application and passed back to look its outcome up. Taken
   * from `card.public_id`, so it identifies the attempt and never the person,
   * and the index below inherits its uniqueness from that column's.
   */
  @Column({
    name: 'request_id',
    type: 'varchar',
    length: 80,
    collation: 'utf8mb4_nopad_bin',
  })
  requestId!: string;

  /**
   * Which catalogue product was applied for. Null for an issuer that publishes
   * no catalogue.
   */
  @Column({
    name: 'card_product_id',
    type: 'bigint',
    unsigned: true,
    nullable: true,
  })
  cardProductId!: string | null;

  @ManyToOne(() => CardProductEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'card_product_id' })
  cardProduct?: CardProductEntity;

  /**
   * The opening deposit committed with this application, denominated in
   * `card_product.currency_code` of the row `card_product_id` points at — not
   * `card.currency`, which is a three-character ISO code and cannot hold the
   * coin tickers a crypto-funded program uses, so the two legitimately
   * disagree.
   */
  @Column({
    name: 'initial_deposit_amount',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  initialDepositAmount!: string | null;

  @Column({
    type: 'varchar',
    length: 24,
    default: CardApplicationStatus.DRAFT,
  })
  status!: CardApplicationStatus;

  /**
   * The issuer's own failure code, or ours when the attempt never left. It
   * also carries a fault reported after the application was approved.
   */
  @Column({ name: 'reason_code', type: 'varchar', length: 40, nullable: true })
  reasonCode!: string | null;

  /** Human-readable detail for the code above. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  message!: string | null;

  /**
   * When an issuer was last asked what became of this application — not when
   * anything about it changed. A pending answer writes nothing else, so this is
   * both the only record the question was put and the batch's rotation key.
   */
  @Column({
    name: 'status_checked_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  statusCheckedAt!: Date | null;

  /**
   * The issuer's most recent raw response, retained for replay. The
   * acknowledgement first, then whatever the result lookup returned.
   */
  @Column({ name: 'response_payload', type: 'json', nullable: true })
  responsePayload!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;
}
