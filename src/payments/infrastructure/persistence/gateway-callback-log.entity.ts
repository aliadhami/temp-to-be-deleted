import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { GatewayKey } from '../../domain/gateway-key.enum';

@Entity('gateway_callback_log')
@Index('idx_callback_gateway_received', ['gatewayKey', 'receivedAt'])
export class GatewayCallbackLogEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'gateway_key', type: 'varchar', length: 20 })
  gatewayKey!: GatewayKey;

  @Column({
    name: 'transaction_public_id',
    type: 'char',
    length: 36,
    nullable: true,
  })
  transactionPublicId!: string | null;

  @Column({ name: 'signature_valid', type: 'boolean' })
  signatureValid!: boolean;

  @Column({ name: 'raw_payload', type: 'json' })
  rawPayload!: Record<string, unknown>;

  @CreateDateColumn({ name: 'received_at', type: 'datetime', precision: 6 })
  receivedAt!: Date;
}
