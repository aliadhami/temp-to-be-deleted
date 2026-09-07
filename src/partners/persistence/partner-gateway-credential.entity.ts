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
import { GatewayKey } from '../../payments/domain/gateway-key.enum';
import { CredentialEnvironment } from '../domain/credential-environment.enum';
import { PartnerEntity } from './partner.entity';

@Entity('partner_gateway_credential')
@Index('uq_partner_gateway_env', ['partnerId', 'gatewayKey', 'environment'], {
  unique: true,
})
export class PartnerGatewayCredentialEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'partner_id', type: 'bigint', unsigned: true })
  partnerId!: string;

  @ManyToOne(() => PartnerEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'partner_id' })
  partner?: PartnerEntity;

  @Column({ name: 'gateway_key', type: 'varchar', length: 20 })
  gatewayKey!: GatewayKey;

  /** Encrypted JSON blob — never plaintext, never logged. Encryption service comes in a later step. */
  @Column({ name: 'credentials_encrypted', type: 'blob' })
  credentialsEncrypted!: Buffer;

  @Column({ type: 'varchar', length: 20 })
  environment!: CredentialEnvironment;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;
}
