import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { PaymentStatus } from '../../domain/payment-status.enum';
import { TransactionEventSource } from '../../domain/transaction-event-source.enum';
import { PaymentTransactionEntity } from './payment-transaction.entity';

@Entity('transaction_event')
@Index('idx_event_txn_created', ['transactionId', 'createdAt'])
export class TransactionEventEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'transaction_id', type: 'bigint', unsigned: true })
  transactionId!: string;

  @ManyToOne(() => PaymentTransactionEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'transaction_id' })
  transaction?: PaymentTransactionEntity;

  @Column({ name: 'from_status', type: 'varchar', length: 24, nullable: true })
  fromStatus!: PaymentStatus | null;

  @Column({ name: 'to_status', type: 'varchar', length: 24 })
  toStatus!: PaymentStatus;

  @Column({ type: 'varchar', length: 20 })
  source!: TransactionEventSource;

  @Column({ type: 'varchar', length: 255, nullable: true })
  detail!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;
}
