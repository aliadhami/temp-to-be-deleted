import { randomUUID } from 'node:crypto';
import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { PartnerEntity } from '../../../partners/persistence/partner.entity';
import type {
  IdentityProvenance,
  ResidentialAddress,
} from '../../domain/cardholder-intent.model';
import { CardholderEnrolmentEntity } from './cardholder-enrolment.entity';

/**
 * A person a partner may hold cards for. Carries no issuer and no status —
 * those are per-issuer and live on `cardholder_enrolment`.
 */
@Entity('cardholder')
@Index('idx_cardholder_partner', ['partnerId'])
export class CardholderEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'public_id', type: 'char', length: 36, unique: true })
  publicId!: string;

  @Column({ name: 'partner_id', type: 'bigint', unsigned: true })
  partnerId!: string;

  @ManyToOne(() => PartnerEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'partner_id' })
  partner?: PartnerEntity;

  @OneToMany(
    () => CardholderEnrolmentEntity,
    (enrolment) => enrolment.cardholder,
  )
  enrolments?: CardholderEnrolmentEntity[];

  @Column({ name: 'first_name', type: 'varchar', length: 150 })
  firstName!: string;

  @Column({ name: 'last_name', type: 'varchar', length: 150 })
  lastName!: string;

  @Column({ type: 'varchar', length: 255 })
  email!: string;

  @Column({ type: 'varchar', length: 20 })
  phone!: string;

  @Column({ name: 'date_of_birth', type: 'date' })
  dateOfBirth!: string;

  @Column({ name: 'residential_address', type: 'json' })
  residentialAddress!: ResidentialAddress;

  @Column({ name: 'identity_provenance', type: 'json' })
  identityProvenance!: IdentityProvenance;

  /**
   * The end user's IP as the partner observed it, null when they sent none.
   * `varchar(45)` is the longest an IPv6 address can be written, including the
   * IPv4-mapped form.
   */
  @Column({ name: 'user_ip', type: 'varchar', length: 45, nullable: true })
  userIp!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;

  @BeforeInsert()
  assignPublicId(): void {
    this.publicId ??= randomUUID();
  }
}
