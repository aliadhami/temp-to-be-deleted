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
import { PaymentTransactionEntity } from '../persistence/payment-transaction.entity';

export enum WebhookDeliveryStatus {
  PENDING = 'PENDING',
  DELIVERED = 'DELIVERED',
  DEAD_LETTER = 'DEAD_LETTER',
}

@Entity('webhook_delivery')
@Index('idx_webhook_delivery_due', ['status', 'nextAttemptAt'])
@Index('idx_webhook_delivery_partner', ['partnerId'])
export class WebhookDeliveryEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'public_id', type: 'char', length: 36, unique: true })
  publicId!: string;

  @Column({ name: 'partner_id', type: 'bigint', unsigned: true })
  partnerId!: string;

  @ManyToOne(() => PartnerEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'partner_id' })
  partner?: PartnerEntity;

  @Column({
    name: 'transaction_id',
    type: 'bigint',
    unsigned: true,
    nullable: true,
  })
  transactionId!: string | null;

  @ManyToOne(() => PaymentTransactionEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'transaction_id' })
  transaction?: PaymentTransactionEntity;

  @Column({ name: 'event_type', type: 'varchar', length: 60 })
  eventType!: string;

  @Column({ type: 'json' })
  payload!: Record<string, unknown>;

  @Column({
    type: 'varchar',
    length: 20,
    default: WebhookDeliveryStatus.PENDING,
  })
  status!: WebhookDeliveryStatus;

  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount!: number;

  @Column({
    name: 'next_attempt_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  nextAttemptAt!: Date | null;

  @Column({ name: 'last_response_status', type: 'int', nullable: true })
  lastResponseStatus!: number | null;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError!: string | null;

  @Column({
    name: 'delivered_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  deliveredAt!: Date | null;

  @Column({
    name: 'cardholder_id',
    type: 'bigint',
    unsigned: true,
    nullable: true,
  })
  cardholderId!: string | null;

  @Column({ name: 'card_id', type: 'bigint', unsigned: true, nullable: true })
  cardId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;

  @BeforeInsert()
  assignPublicId(): void {
    this.publicId ??= randomUUID();
  }
}
