import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { GatewayKey } from '../../domain/gateway-key.enum';
import { PaymentMethod } from '../../domain/payment-method.enum';

@Entity('routing_rule')
@Index('idx_rule_priority_active', ['priority', 'isActive'])
export class RoutingRuleEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ type: 'int' })
  priority!: number;

  @Column({
    name: 'match_currency',
    type: 'varchar',
    length: 3,
    nullable: true,
  })
  matchCurrency!: string | null;

  @Column({ name: 'match_country', type: 'char', length: 2, nullable: true })
  matchCountry!: string | null;

  @Column({ name: 'match_method', type: 'varchar', length: 20, nullable: true })
  matchMethod!: PaymentMethod | null;

  @Column({
    name: 'match_partner_id',
    type: 'bigint',
    unsigned: true,
    nullable: true,
  })
  matchPartnerId!: string | null;

  @Column({ name: 'primary_gateway', type: 'varchar', length: 20 })
  primaryGateway!: GatewayKey;

  @Column({
    name: 'fallback_gateway',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  fallbackGateway!: GatewayKey | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;
}
