import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CardCapability } from '../domain/card-capability.enum';
import { supportsCapability } from '../domain/card-issuer-guards';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { CardProviderUnsupportedOperationError } from '../domain/card-provider-unsupported-operation.error';
import { CardEventSource } from '../domain/card-event-source.enum';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardholderEventEntity } from '../infrastructure/persistence/cardholder-event.entity';
import { CardholderEnrolmentEntity } from '../infrastructure/persistence/cardholder-enrolment.entity';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardholderEnrolmentResolver } from './cardholder-enrolment.resolver';

@Injectable()
export class SubmitKycUseCase {
  constructor(
    @InjectRepository(CardholderEntity)
    private readonly cardholderRepository: Repository<CardholderEntity>,
    @InjectRepository(CardholderEnrolmentEntity)
    private readonly enrolmentRepository: Repository<CardholderEnrolmentEntity>,
    @InjectRepository(CardholderEventEntity)
    private readonly eventRepository: Repository<CardholderEventEntity>,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
    private readonly enrolmentResolver: CardholderEnrolmentResolver,
  ) {}

  async execute(
    partnerId: string,
    cardholderPublicId: string,
    providerKey: CardProviderKey,
  ) {
    const cardholder = await this.cardholderRepository.findOne({
      where: { publicId: cardholderPublicId, partnerId },
    });
    if (!cardholder) throw new NotFoundException('Cardholder not found');

    const enrolment = await this.enrolmentResolver.require(
      cardholder.id,
      providerKey,
    );
    if (!enrolment.providerCardholderId) {
      throw new ConflictException(
        `Cardholder onboarding with card provider "${providerKey}" has not completed — there is nothing to submit KYC against`,
      );
    }

    const adapter = this.cardIssuerRegistry.resolve(providerKey);
    // KYC submission is part of onboarding, so it rides the same capability
    // rather than inventing a second flag for one step of the same flow.
    if (!supportsCapability(adapter, CardCapability.ONBOARD_CARDHOLDER)) {
      throw new ForbiddenException(
        `Card provider "${providerKey}" does not support cardholder onboarding`,
      );
    }

    const idempotencyKey = `kyc-submit-${cardholder.publicId}-${providerKey}-${Date.now()}`;
    let result;
    try {
      result = await adapter.submitKyc(
        enrolment.providerCardholderId,
        {},
        idempotencyKey,
      );
    } catch (error) {
      // The issuer has no separate KYC step at all — not one that refused this
      // submission.
      if (error instanceof CardProviderUnsupportedOperationError) {
        throw new ConflictException(error.reason, { cause: error });
      }

      // The issuer has the step and refused this cardholder's state — KYC
      // already submitted, or an account no longer eligible. The provider's own
      // message is deliberately not echoed: unlike the reason above, it is
      // remote text of unknown shape.
      if (error instanceof CardProviderConflictError) {
        throw new ConflictException(
          'Cardholder is not in a state that allows KYC submission',
          { cause: error },
        );
      }

      // Both branches key on the error type, never on the provider key — a
      // second issuer in either position is answered without an edit here.
      throw error;
    }

    const previousStatus = enrolment.status;
    enrolment.status = result.status;
    await this.enrolmentRepository.save(enrolment);

    await this.eventRepository.save(
      this.eventRepository.create({
        cardholderEnrolmentId: enrolment.id,
        fromStatus: previousStatus,
        toStatus: result.status,
        source: CardEventSource.KYC_SUBMIT,
      }),
    );

    return {
      publicId: cardholder.publicId,
      providerKey: enrolment.providerKey,
      status: enrolment.status,
      ...(result.kycUrl && { kycUrl: result.kycUrl }),
    };
  }
}
