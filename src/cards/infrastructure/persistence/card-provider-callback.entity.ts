import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CardProviderKey } from '../../domain/card-provider-key.enum';

/**
 * **Cutting to these is the writer's job**: the server runs strict, so an
 * over-length value makes the row unwritable rather than being truncated.
 */
export const CARD_PROVIDER_CALLBACK_EVENT_LABEL_MAX_LENGTH = 64;
export const CARD_PROVIDER_CALLBACK_LAST_ERROR_MAX_LENGTH = 500;

export const CARD_PROVIDER_CALLBACK_DELIVERY_KEY_MAX_LENGTH = 128;
export const CARD_PROVIDER_CALLBACK_DEDUPE_KEY_MAX_LENGTH = 160;

export const CARD_PROVIDER_CALLBACK_DEDUPE_INDEX =
  'uq_card_provider_callback_dedupe';

/**
 * **Null while `signature_valid` is false**, so a refused delivery never
 * occupies the slot a later valid one needs — nulls do not collide.
 *
 * **Length-prefixed, and the prefix is load-bearing.** Both halves are
 * variable-length and nothing holds `provider_key` to the enum, so joined on a
 * separator alone `('A:B', 'c')` and `('A', 'B:c')` are one key.
 *
 * The migration carries the same text; the colocated spec holds the two
 * together.
 */
export const CARD_PROVIDER_CALLBACK_DEDUPE_EXPRESSION =
  "IF(`signature_valid`, CONCAT(CHAR_LENGTH(`provider_key`), ':', `provider_key`, `delivery_key`), NULL)";

/**
 * One inbound callback from a card provider, written before anything acts on
 * it, because the same event arrives more than once.
 *
 * **Nothing prunes this table**, and anything that later does must clear a
 * provider's whole retry window — about forty-four hours for the one in use.
 * Deleting inside it lets a redelivery through as a new event.
 */
@Entity('card_provider_callback')
@Index('idx_card_provider_callback_received', ['providerKey', 'createdAt'])
/** **Not unique** — a refused delivery repeats this pair once per retry. */
@Index('idx_card_provider_callback_delivery', ['providerKey', 'deliveryKey'])
export class CardProviderCallbackEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  // No `public_id`: no route addresses a callback, and none is ever exposed.

  @Column({ name: 'provider_key', type: 'varchar', length: 20 })
  providerKey!: CardProviderKey;

  /** Their own name for the event, as received; null if it carried none. */
  @Column({
    name: 'event_label',
    type: 'varchar',
    length: CARD_PROVIDER_CALLBACK_EVENT_LABEL_MAX_LENGTH,
    nullable: true,
  })
  eventLabel!: string | null;

  @Column({ name: 'signature_valid', type: 'boolean' })
  signatureValid!: boolean;

  /** The complete, unmodified body received. */
  @Column({ type: 'json' })
  payload!: Record<string, unknown>;

  /** Written only when verification failed; nothing diagnoses one otherwise. */
  @Column({ type: 'json', nullable: true })
  headers!: Record<string, string> | null;

  /**
   * What makes two arrivals the same delivery, derived inside the provider's
   * own adapter from the body alone.
   *
   * **Never null**, refused or accepted: a null here nulls the generated column
   * and disables the duplicate check with no other symptom.
   *
   * **`varchar`, never `char`** — a `char` is right-padded on storage whatever
   * its collation, collapsing two keys that differ only in trailing space.
   */
  @Column({
    name: 'delivery_key',
    type: 'varchar',
    length: CARD_PROVIDER_CALLBACK_DELIVERY_KEY_MAX_LENGTH,
    collation: 'utf8mb4_nopad_bin',
  })
  deliveryKey!: string;

  /** Server-generated; never written by application code. */
  @Column({
    name: 'dedupe_key',
    type: 'varchar',
    length: CARD_PROVIDER_CALLBACK_DEDUPE_KEY_MAX_LENGTH,
    collation: 'utf8mb4_nopad_bin',
    nullable: true,
    asExpression: CARD_PROVIDER_CALLBACK_DEDUPE_EXPRESSION,
    generatedType: 'VIRTUAL',
  })
  @Index(CARD_PROVIDER_CALLBACK_DEDUPE_INDEX, { unique: true })
  dedupeKey!: string | null;

  /** When it was acted on — not when it arrived, which is `created_at`. */
  @Column({
    name: 'processed_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  processedAt!: Date | null;

  /**
   * **Counts on the verified path only** — a refused delivery holds no key to
   * collide on, so each of its retries inserts a row of its own.
   */
  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount!: number;

  @Column({
    name: 'last_error',
    type: 'varchar',
    length: CARD_PROVIDER_CALLBACK_LAST_ERROR_MAX_LENGTH,
    nullable: true,
  })
  lastError!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;
}
