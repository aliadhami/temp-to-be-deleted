import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { PaymentTransactionEntity } from './payment-transaction.entity';

@Entity('fee_record')
@Index('idx_fee_transaction', ['transactionId'])
export class FeeRecordEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'transaction_id', type: 'bigint', unsigned: true })
  transactionId!: string;

  @ManyToOne(() => PaymentTransactionEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'transaction_id' })
  transaction?: PaymentTransactionEntity;

  @Column({ name: 'gateway_fee', type: 'decimal', precision: 38, scale: 18 })
  gatewayFee!: string;

  @Column({
    name: 'partner_fee',
    type: 'decimal',
    precision: 38,
    scale: 18,
    nullable: true,
  })
  partnerFee!: string | null;

  @Column({ type: 'varchar', length: 20 })
  currency!: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;
}
