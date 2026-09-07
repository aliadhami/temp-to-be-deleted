import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { PartnerEntity } from './partner.entity';
import { ApiKeyScope } from '../domain/api-key-scope.enum';

export enum PartnerApiKeyStatus {
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
}

@Entity('partner_api_key')
@Index('idx_api_key_key_id', ['keyId'], { unique: true })
@Index('idx_api_key_partner', ['partnerId'])
export class PartnerApiKeyEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'partner_id', type: 'bigint', unsigned: true })
  partnerId!: string;

  @ManyToOne(() => PartnerEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'partner_id' })
  partner?: PartnerEntity;

  /** Public lookup identifier — safe to log, not secret on its own. */
  @Column({ name: 'key_id', type: 'varchar', length: 32 })
  keyId!: string;

  /** SHA-256 hash of the secret portion. The secret itself is shown once, never stored. */
  @Column({ name: 'secret_hash', type: 'char', length: 64 })
  secretHash!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  label!: string | null;

  @Column({ type: 'varchar', length: 20, default: PartnerApiKeyStatus.ACTIVE })
  status!: PartnerApiKeyStatus;

  @Column({
    name: 'last_used_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  lastUsedAt!: Date | null;

  @Column({ type: 'json' })
  scopes!: ApiKeyScope[];

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;
}
