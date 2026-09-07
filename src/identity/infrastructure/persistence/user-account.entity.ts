import { randomUUID } from 'node:crypto';
import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { PartnerEntity } from '../../../partners/persistence/partner.entity';
import { UserStatus } from '../../domain/user-status.enum';
import { RoleEntity } from './role.entity';

@Entity('user_account')
@Index('idx_user_partner', ['partnerId'])
export class UserAccountEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'public_id', type: 'char', length: 36, unique: true })
  publicId!: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  email!: string;

  /** Argon2 hash — hashing service arrives with the auth step. Never selected by default. */
  @Column({
    name: 'password_hash',
    type: 'varchar',
    length: 255,
    select: false,
  })
  passwordHash!: string;

  @Column({ name: 'display_name', type: 'varchar', length: 150 })
  displayName!: string;

  @Column({ name: 'is_partner_user', type: 'boolean', default: false })
  isPartnerUser!: boolean;

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

  @Column({ type: 'varchar', length: 20, default: UserStatus.ACTIVE })
  status!: UserStatus;

  @Column({ name: 'mfa_enabled', type: 'boolean', default: false })
  mfaEnabled!: boolean;

  @ManyToMany(() => RoleEntity, { eager: false })
  @JoinTable({
    name: 'user_role',
    joinColumn: { name: 'user_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'role_id', referencedColumnName: 'id' },
  })
  roles?: RoleEntity[];

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;

  @BeforeInsert()
  assignPublicId(): void {
    this.publicId ??= randomUUID();
  }
}
