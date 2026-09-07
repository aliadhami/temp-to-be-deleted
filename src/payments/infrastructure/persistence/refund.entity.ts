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
import { UserAccountEntity } from '../../../identity/infrastructure/persistence/user-account.entity';
import { GatewayKey } from '../../domain/gateway-key.enum';
import { RefundStatus } from '../../domain/refund-status.enum';
import { PaymentTransactionEntity } from './payment-transaction.entity';

@Entity('refund')
@Index('idx_refund_transaction', ['transactionId'])
export class RefundEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'public_id', type: 'char', length: 36, unique: true })
  publicId!: string;

  @Column({ name: 'transaction_id', type: 'bigint', unsigned: true })
  transactionId!: string;

  @ManyToOne(() => PaymentTransactionEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'transaction_id' })
  transaction?: PaymentTransactionEntity;

  @Column({ name: 'gateway_key', type: 'varchar', length: 20 })
  gatewayKey!: GatewayKey;

  @Column({ type: 'decimal', precision: 38, scale: 18 })
  amount!: string;

  @Column({ type: 'varchar', length: 24, default: RefundStatus.PENDING })
  status!: RefundStatus;

  @Column({ name: 'provider_ref', type: 'varchar', length: 80, nullable: true })
  providerRef!: string | null;

  @Column({ name: 'requested_by', type: 'bigint', unsigned: true })
  requestedBy!: string;

  @ManyToOne(() => UserAccountEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'requested_by' })
  requester?: UserAccountEntity;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;

  @BeforeInsert()
  assignPublicId(): void {
    this.publicId ??= randomUUID();
  }
}
