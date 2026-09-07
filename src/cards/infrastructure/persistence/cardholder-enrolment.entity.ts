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
import { CardProviderKey } from '../../domain/card-provider-key.enum';
import { CardholderStatus } from '../../domain/cardholder-status.enum';
import { CardholderEntity } from './cardholder.entity';

/**
 * Both `cardholder_enrolment.message` and `cardholder_event.detail` are
 * `varchar(255)`, so anything written to either is cut to fit in application
 * code rather than by the database, which truncates silently or rejects
 * outright depending on the server's mode.
 */
export const CARDHOLDER_ENROLMENT_MESSAGE_MAX_LENGTH = 255;

/**
 * One person's standing with one issuer — a cardholder is the person, and this
 * row is what an issuer decided about them. Addressed by the cardholder's
 * public id and a provider key, never by an id of its own.
 */
@Entity('cardholder_enrolment')
@Index('idx_cardholder_enrolment_status', ['status'])
@Index('idx_cardholder_enrolment_provider', [
  'providerKey',
  'providerCardholderId',
])
@Index('uq_cardholder_enrolment_provider', ['cardholderId', 'providerKey'], {
  unique: true,
})
export class CardholderEnrolmentEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'cardholder_id', type: 'bigint', unsigned: true })
  cardholderId!: string;

  @ManyToOne(() => CardholderEntity, (cardholder) => cardholder.enrolments, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'cardholder_id' })
  cardholder?: CardholderEntity;

  @Column({ name: 'provider_key', type: 'varchar', length: 20 })
  providerKey!: CardProviderKey;

  /**
   * The issuer's own identifier for this person — null until onboarding
   * succeeds. An issuer that mints none holds a locally derived reference
   * here, which that issuer has never been sent.
   */
  @Column({
    name: 'provider_cardholder_id',
    type: 'varchar',
    length: 80,
    nullable: true,
  })
  providerCardholderId!: string | null;

  @Column({ type: 'varchar', length: 24, default: CardholderStatus.DRAFT })
  status!: CardholderStatus;

  /** Decimal-string generation/revision pair, per Axys's KYC lifecycle model — kept generic for other providers. */
  @Column({
    name: 'kyc_generation',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  kycGeneration!: string | null;

  @Column({ name: 'kyc_revision', type: 'varchar', length: 20, nullable: true })
  kycRevision!: string | null;

  @Column({ name: 'reason_code', type: 'varchar', length: 40, nullable: true })
  reasonCode!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  message!: string | null;

  /** Last raw provider response, for debugging — never the KYC URL (that's single-use, return-only, never persisted). */
  @Column({ name: 'response_payload', type: 'json', nullable: true })
  responsePayload!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;
}
