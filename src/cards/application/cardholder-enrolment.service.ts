import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { PartnerEntity } from '../../partners/persistence/partner.entity';
import { isDuplicateEntryError } from '../../shared/persistence/duplicate-entry.util';
import { CardCapability } from '../domain/card-capability.enum';
import { CardEventSource } from '../domain/card-event-source.enum';
import { supportsCapability } from '../domain/card-issuer-guards';
import { CardIssuerPort } from '../domain/card-issuer.port';
import { CardProviderIntentRejectedError } from '../domain/card-provider-intent-rejected.error';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardholderStatus } from '../domain/cardholder-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import {
  CARDHOLDER_ENROLMENT_MESSAGE_MAX_LENGTH,
  CardholderEnrolmentEntity,
} from '../infrastructure/persistence/cardholder-enrolment.entity';
import { CardholderEventEntity } from '../infrastructure/persistence/cardholder-event.entity';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';

/** The index that makes one person's enrolment with one issuer singular. */
const ENROLMENT_UNIQUE_INDEX = 'uq_cardholder_enrolment_provider';

/**
 * The one state a further attempt may write over. Every other state is either
 * the issuer's answer — including a decline, where asking again would put a
 * second question to an issuer that has already answered the first — or
 * `DRAFT`, which means an attempt is in flight and its outcome is unknown.
 */
const REATTEMPTABLE_STATUSES = new Set<CardholderStatus>([
  CardholderStatus.ERROR,
]);

/**
 * What a partner is told when onboarding failed for a reason that is not about
 * their data.
 */
const OPAQUE_FAILURE_MESSAGE =
  'Onboarding could not be completed with the card provider. Contact support if this persists.';

export interface EnrolCardholderResult {
  enrolment: CardholderEnrolmentEntity;
  kycUrl?: string;
}

/**
 * Puts a person to one issuer and records what it answered. Shared by the call
 * that creates a cardholder and the call that adds a further issuer to one, so
 * the two cannot come to disagree about what enrolling means.
 */
@Injectable()
export class CardholderEnrolmentService {
  private readonly logger = new Logger(CardholderEnrolmentService.name);

  constructor(
    @InjectRepository(CardholderEnrolmentEntity)
    private readonly enrolmentRepository: Repository<CardholderEnrolmentEntity>,
    @InjectRepository(CardholderEventEntity)
    private readonly eventRepository: Repository<CardholderEventEntity>,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Every refusal this service can raise before it writes anything, and the
   * adapter they clear the way to.
   *
   * **A caller that persists a row of its own must run this first.** Both
   * paths here are persistence-first, so a refusal raised after a write leaves
   * that row behind with nothing to clean it up — and for the onboarding path
   * the row is a person carrying the partner's identity material.
   */
  assertCanEnrol(
    partner: PartnerEntity,
    providerKey: CardProviderKey,
  ): CardIssuerPort {
    if (!partner.allowedGateways.includes(providerKey)) {
      // Reuses the partner's allowedGateways list for now — a dedicated
      // allowedCardProviders column is a reasonable follow-up once a second
      // card provider actually exists.
      throw new ForbiddenException(
        `Partner is not permitted to use card provider "${providerKey}"`,
      );
    }

    // Throws 400 for a known-but-disabled provider key.
    const adapter = this.cardIssuerRegistry.resolve(providerKey);

    if (!supportsCapability(adapter, CardCapability.ONBOARD_CARDHOLDER)) {
      throw new ForbiddenException(
        `Card provider "${providerKey}" does not support cardholder onboarding`,
      );
    }

    return adapter;
  }

  async enrol(
    cardholder: CardholderEntity,
    partner: PartnerEntity,
    providerKey: CardProviderKey,
  ): Promise<EnrolCardholderResult> {
    // Re-run rather than assumed: `enrol` is reachable from a caller that has
    // not called it, and the checks are in-memory.
    const adapter = this.assertCanEnrol(partner, providerKey);

    const { enrolment, fromStatus } = await this.claimEnrolment(
      cardholder,
      providerKey,
    );

    // Keyed on the person rather than the enrolment: one issuer is asked about
    // one person once, and each issuer has its own key namespace.
    const idempotencyKey = `account-${cardholder.publicId}`;
    const result = await this.callProvider(enrolment, fromStatus, () =>
      adapter.onboardCardholder(
        {
          // The cardholder's own public id, never the enrolment's. An issuer
          // that mints no identifier derives one from this, so a person's
          // reference must not change when they are put to a second issuer.
          publicId: cardholder.publicId,
          partnerId: cardholder.partnerId,
          providerKey,
          firstName: cardholder.firstName,
          lastName: cardholder.lastName,
          email: cardholder.email,
          phone: cardholder.phone,
          dateOfBirth: cardholder.dateOfBirth,
          residentialAddress: cardholder.residentialAddress,
          identityProvenance: cardholder.identityProvenance,
          // Conditional spread rather than `?? undefined`: under
          // `exactOptionalPropertyTypes` an optional field cannot be set to
          // undefined, so an absent IP means an absent key.
          ...(cardholder.userIp && { userIp: cardholder.userIp }),
        },
        {},
        idempotencyKey,
      ),
    );

    enrolment.providerCardholderId = result.providerCardholderId;
    enrolment.status = result.status;
    const saved = await this.enrolmentRepository.save(enrolment);

    await this.eventRepository.save(
      this.eventRepository.create({
        cardholderEnrolmentId: saved.id,
        fromStatus,
        toStatus: result.status,
        source: CardEventSource.ONBOARD,
      }),
    );

    return {
      enrolment: saved,
      // kycUrl deliberately not persisted — single-use, return-only, per Axys spec.
      ...(result.kycUrl && { kycUrl: result.kycUrl }),
    };
  }

  /**
   * The `DRAFT` row this attempt will write, committed before the provider is
   * reached, along with the status it is displacing.
   *
   * **Insert first, and lock only after it collides.** The unique index
   * already decides between two first-time attempts, so the ordinary path
   * takes no lock at all — and a locking read for a row that does not exist
   * would gap-lock `uq_cardholder_enrolment_provider`, blocking every other
   * cardholder's first enrolment behind it. Once the row is known to exist the
   * lock is on that record alone, which is what stops two re-attempts both
   * reading the same pre-attempt status and both proceeding.
   *
   * The provider is called after this returns, never while the lock is held.
   */
  private async claimEnrolment(
    cardholder: CardholderEntity,
    providerKey: CardProviderKey,
  ): Promise<{
    enrolment: CardholderEnrolmentEntity;
    fromStatus: CardholderStatus;
  }> {
    try {
      const created = await this.enrolmentRepository.save(
        this.enrolmentRepository.create({
          cardholderId: cardholder.id,
          providerKey,
          status: CardholderStatus.DRAFT,
        }),
      );
      return { enrolment: created, fromStatus: CardholderStatus.DRAFT };
    } catch (error) {
      if (!isDuplicateEntryError(error, ENROLMENT_UNIQUE_INDEX)) throw error;
    }

    return this.reclaimEnrolment(cardholder, providerKey);
  }

  /** The locked half, reached only once a row is known to exist. */
  private reclaimEnrolment(
    cardholder: CardholderEntity,
    providerKey: CardProviderKey,
  ): Promise<{
    enrolment: CardholderEnrolmentEntity;
    fromStatus: CardholderStatus;
  }> {
    return this.dataSource.transaction(async (manager) => {
      const enrolments = manager.getRepository(CardholderEnrolmentEntity);

      const existing = await enrolments.findOne({
        where: { cardholderId: cardholder.id, providerKey },
        lock: { mode: 'pessimistic_write' },
      });

      if (!existing) {
        // Deleted between the failed insert and this read. Nothing removes an
        // enrolment today, so this is an operator with a SQL client rather
        // than a state the service produces.
        throw new ConflictException(
          `Enrolment with card provider "${providerKey}" changed underneath this request — try again`,
        );
      }

      if (!REATTEMPTABLE_STATUSES.has(existing.status)) {
        throw new ConflictException(
          existing.status === CardholderStatus.DRAFT
            ? `An enrolment with card provider "${providerKey}" is already in flight for this cardholder`
            : `Cardholder is already enrolled with card provider "${providerKey}" (${existing.status})`,
        );
      }

      const fromStatus = existing.status;
      existing.status = CardholderStatus.DRAFT;
      existing.message = null;
      return { enrolment: await enrolments.save(existing), fromStatus };
    });
  }

  /**
   * Runs the provider call and, if it fails, leaves the row saying so. This is
   * persistence-first, so the `DRAFT` row is already committed by the time the
   * provider is reached.
   */
  private async callProvider<T>(
    enrolment: CardholderEnrolmentEntity,
    fromStatus: CardholderStatus,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      await this.recordFailure(enrolment, fromStatus, error);

      if (error instanceof CardProviderIntentRejectedError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /**
   * Writes the failure onto the row, and never displaces the error that caused
   * it.
   */
  private async recordFailure(
    enrolment: CardholderEnrolmentEntity,
    fromStatus: CardholderStatus,
    error: unknown,
  ): Promise<void> {
    const reason =
      error instanceof Error ? error.message : 'Unknown provider failure';

    // A refusal of the partner's own data is written for them to read; anything
    // else is internal and only its shape is published.
    const partnerMessage =
      error instanceof CardProviderIntentRejectedError
        ? reason
        : OPAQUE_FAILURE_MESSAGE;

    this.logger.warn(
      `Onboarding failed for cardholder ${enrolment.cardholderId} on ${enrolment.providerKey}: ${reason}`,
    );

    try {
      enrolment.status = CardholderStatus.ERROR;
      enrolment.message = partnerMessage.slice(
        0,
        CARDHOLDER_ENROLMENT_MESSAGE_MAX_LENGTH,
      );
      await this.enrolmentRepository.save(enrolment);

      await this.eventRepository.save(
        this.eventRepository.create({
          cardholderEnrolmentId: enrolment.id,
          fromStatus,
          toStatus: CardholderStatus.ERROR,
          source: CardEventSource.ONBOARD,
          // The event table is internal, so the real reason is kept here even
          // when the partner-facing column carries only the opaque form.
          detail: reason.slice(0, CARDHOLDER_ENROLMENT_MESSAGE_MAX_LENGTH),
        }),
      );
    } catch (bookkeepingError) {
      this.logger.error(
        `Could not record the onboarding failure for cardholder ${enrolment.cardholderId} on ${enrolment.providerKey}, leaving it in ${fromStatus}: ${
          bookkeepingError instanceof Error
            ? bookkeepingError.message
            : String(bookkeepingError)
        }`,
      );
    }
  }
}
