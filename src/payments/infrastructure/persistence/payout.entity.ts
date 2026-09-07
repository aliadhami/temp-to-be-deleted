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
import { PartnerEntity } from '../../../partners/persistence/partner.entity';
import { GatewayKey } from '../../domain/gateway-key.enum';
import { PayoutStatus } from '../../domain/payout-status.enum';

@Entity('payout')
@Index('uq_payout_gateway_order', ['gatewayKey', 'orderNum'], { unique: true })
@Index('idx_payout_status', ['status'])
@Index('idx_payout_partner', ['partnerId'])
export class PayoutEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

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

  @Column({ name: 'order_num', type: 'varchar', length: 64 })
  orderNum!: string;

  @Column({ type: 'decimal', precision: 38, scale: 18 })
  amount!: string;

  @Column({ type: 'varchar', length: 20 })
  currency!: string;

  @Column({ name: 'beneficiary_name', type: 'varchar', length: 150 })
  beneficiaryName!: string;

  @Column({ name: 'beneficiary_account', type: 'varchar', length: 64 })
  beneficiaryAccount!: string;

  @Column({ name: 'bank_code', type: 'varchar', length: 20, nullable: true })
  bankCode!: string | null;

  @Column({ type: 'varchar', length: 24, default: PayoutStatus.DRAFT })
  status!: PayoutStatus;

  @Column({ name: 'provider_ref', type: 'varchar', length: 80, nullable: true })
  providerRef!: string | null;

  @Column({ type: 'decimal', precision: 38, scale: 18, nullable: true })
  fee!: string | null;

  @Column({ name: 'created_by', type: 'bigint', unsigned: true })
  createdBy!: string;

  @ManyToOne(() => UserAccountEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'created_by' })
  creator?: UserAccountEntity;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;

  @BeforeInsert()
  assignPublicId(): void {
    this.publicId ??= randomUUID();
  }
}
