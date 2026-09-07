import { randomUUID } from 'node:crypto';
import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { PartnerStatus } from '../domain/partner-status.enum';

@Entity('partner')
export class PartnerEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'public_id', type: 'char', length: 36, unique: true })
  publicId!: string;

  @Column({ type: 'varchar', length: 150 })
  name!: string;

  @Column({ type: 'varchar', length: 20, default: PartnerStatus.ACTIVE })
  status!: PartnerStatus;

  @Column({ name: 'allowed_gateways', type: 'json' })
  allowedGateways!: string[];

  @Column({ name: 'allowed_currencies', type: 'json' })
  allowedCurrencies!: string[];

  @Column({ name: 'allowed_methods', type: 'json' })
  allowedMethods!: string[];

  @Column({
    name: 'fee_percent',
    type: 'decimal',
    precision: 6,
    scale: 3,
    nullable: true,
  })
  feePercent!: string | null;

  @Column({
    name: 'fee_flat',
    type: 'decimal',
    precision: 38,
    scale: 18,
    nullable: true,
  })
  feeFlat!: string | null;

  @Column({ name: 'webhook_url', type: 'varchar', length: 500, nullable: true })
  webhookUrl!: string | null;

  @Column({ name: 'webhook_secret_encrypted', type: 'blob', nullable: true })
  webhookSecretEncrypted!: Buffer | null;

  /** Where the customer's browser is redirected after completing checkout (browser-redirect gateways only). */
  @Column({
    name: 'checkout_return_url',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  checkoutReturnUrl!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;

  @BeforeInsert()
  assignPublicId(): void {
    this.publicId ??= randomUUID();
  }
}
