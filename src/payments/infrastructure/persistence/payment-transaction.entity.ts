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
import { GatewayKey } from '../../domain/gateway-key.enum';
import { PaymentMethod } from '../../domain/payment-method.enum';
import { PaymentStatus } from '../../domain/payment-status.enum';
import { PartnerEntity } from '../../../partners/persistence/partner.entity';

@Entity('payment_transaction')
@Index('uq_txn_gateway_request', ['gatewayKey', 'requestId'], { unique: true })
@Index('idx_txn_status', ['status'])
@Index('idx_txn_partner', ['partnerId'])
@Index('idx_txn_reference', ['referenceNumber'])
@Index('idx_txn_provider_ref', ['providerRef'])
@Index('idx_txn_created_at', ['createdAt'])
export class PaymentTransactionEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string; // mysql2 returns BIGINT as string — keep it that way

  @Column({ name: 'public_id', type: 'char', length: 36, unique: true })
  publicId!: string;

  @Column({
    name: 'partner_id',
    type: 'bigint',
    unsigned: true,
    nullable: true,
  })
  partnerId!: string | null;

  @ManyToOne(() => PartnerEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'partner_id' })
  partner?: PartnerEntity;

  @Column({ name: 'gateway_key', type: 'varchar', length: 20 })
  gatewayKey!: GatewayKey;

  @Column({ name: 'request_id', type: 'varchar', length: 64 })
  requestId!: string;

  @Column({ name: 'reference_number', type: 'varchar', length: 64 })
  referenceNumber!: string;

  @Column({ type: 'varchar', length: 20 })
  method!: PaymentMethod;

  @Column({ type: 'decimal', precision: 38, scale: 18 })
  amount!: string; // DECIMAL arrives as string — never coerce to number

  @Column({ type: 'varchar', length: 20 })
  currency!: string;

  @Column({ type: 'varchar', length: 24, default: PaymentStatus.PENDING })
  status!: PaymentStatus;

  @Column({
    name: 'refunded_amount',
    type: 'decimal',
    precision: 38,
    scale: 18,
    default: 0,
  })
  refundedAmount!: string;

  @Column({ name: 'reason_code', type: 'varchar', length: 20, nullable: true })
  reasonCode!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  message!: string | null;

  @Column({ name: 'provider_ref', type: 'varchar', length: 80, nullable: true })
  providerRef!: string | null;

  @Column({
    name: 'customer_email',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  customerEmail!: string | null;

  @Column({
    name: 'customer_name',
    type: 'varchar',
    length: 150,
    nullable: true,
  })
  customerName!: string | null;

  @Column({ name: 'customer_country', type: 'char', length: 2, nullable: true })
  customerCountry!: string | null;

  @Column({
    name: 'callback_url',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  callbackUrl!: string | null;

  @Column({ name: 'request_payload', type: 'json', nullable: true })
  requestPayload!: Record<string, unknown> | null;

  @Column({ name: 'response_payload', type: 'json', nullable: true })
  responsePayload!: Record<string, unknown> | null;

  @Column({ name: 'initiated_at', type: 'datetime', precision: 6 })
  initiatedAt!: Date;

  @Column({
    name: 'completed_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  completedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;

  @BeforeInsert()
  assignPublicId(): void {
    this.publicId ??= randomUUID();
  }
}
