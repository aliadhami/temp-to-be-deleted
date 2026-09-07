import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CardEventSource } from '../../domain/card-event-source.enum';
import { CardStatus } from '../../domain/card-status.enum';
import { CardEntity } from './card.entity';

/**
 * The width a writer has to cut `detail` down to, declared beside the column
 * rather than restated by each caller that composes one — so a migration
 * widening it moves one number instead of leaving copies silently truncating.
 */
export const CARD_EVENT_DETAIL_MAX_LENGTH = 255;

@Entity('card_event')
@Index('idx_card_event_created', ['cardId', 'createdAt'])
export class CardEventEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'card_id', type: 'bigint', unsigned: true })
  cardId!: string;

  @ManyToOne(() => CardEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'card_id' })
  card?: CardEntity;

  @Column({ name: 'from_status', type: 'varchar', length: 20, nullable: true })
  fromStatus!: CardStatus | null;

  @Column({ name: 'to_status', type: 'varchar', length: 20 })
  toStatus!: CardStatus;

  @Column({ type: 'varchar', length: 20 })
  source!: CardEventSource;

  @Column({ type: 'varchar', length: 255, nullable: true })
  detail!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;
}
