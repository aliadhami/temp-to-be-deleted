import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { UserAccountEntity } from '../../../identity/infrastructure/persistence/user-account.entity';
import { ApprovalDecision } from '../../domain/approval-decision.enum';
import { PayoutEntity } from './payout.entity';

@Entity('payout_approval')
export class PayoutApprovalEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'payout_id', type: 'bigint', unsigned: true })
  payoutId!: string;

  @ManyToOne(() => PayoutEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'payout_id' })
  payout?: PayoutEntity;

  @Column({ name: 'approver_id', type: 'bigint', unsigned: true })
  approverId!: string;

  @ManyToOne(() => UserAccountEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'approver_id' })
  approver?: UserAccountEntity;

  @Column({ type: 'varchar', length: 20 })
  decision!: ApprovalDecision;

  @Column({ type: 'varchar', length: 255, nullable: true })
  note!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;
}
