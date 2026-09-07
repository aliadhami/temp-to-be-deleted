import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { UserAccountEntity } from '../../../identity/infrastructure/persistence/user-account.entity';

@Entity('audit_log')
@Index('idx_audit_action_created', ['action', 'createdAt'])
@Index('idx_audit_actor', ['actorUserId'])
export class AuditLogEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({
    name: 'actor_user_id',
    type: 'bigint',
    unsigned: true,
    nullable: true,
  })
  actorUserId!: string | null; // NULL = system

  @ManyToOne(() => UserAccountEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'actor_user_id' })
  actor?: UserAccountEntity;

  @Column({ type: 'varchar', length: 60 })
  action!: string;

  @Column({ name: 'target_type', type: 'varchar', length: 40 })
  targetType!: string;

  @Column({
    name: 'target_public_id',
    type: 'char',
    length: 36,
    nullable: true,
  })
  targetPublicId!: string | null;

  @Column({ name: 'before_json', type: 'json', nullable: true })
  beforeJson!: Record<string, unknown> | null;

  @Column({ name: 'after_json', type: 'json', nullable: true })
  afterJson!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;
}
