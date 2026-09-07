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
import { CardholderStatus } from '../../domain/cardholder-status.enum';
import { CardholderEnrolmentEntity } from './cardholder-enrolment.entity';

/** Append-only history of one enrolment's status, never of a person's. */
@Entity('cardholder_event')
@Index('idx_cardholder_event_created', ['cardholderEnrolmentId', 'createdAt'])
export class CardholderEventEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'cardholder_enrolment_id', type: 'bigint', unsigned: true })
  cardholderEnrolmentId!: string;

  @ManyToOne(() => CardholderEnrolmentEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'cardholder_enrolment_id' })
  enrolment?: CardholderEnrolmentEntity;

  @Column({ name: 'from_status', type: 'varchar', length: 24, nullable: true })
  fromStatus!: CardholderStatus | null;

  @Column({ name: 'to_status', type: 'varchar', length: 24 })
  toStatus!: CardholderStatus;

  @Column({ type: 'varchar', length: 20 })
  source!: CardEventSource;

  @Column({ type: 'varchar', length: 255, nullable: true })
  detail!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;
}
