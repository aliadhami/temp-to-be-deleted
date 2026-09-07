import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { CardEventSource } from '../domain/card-event-source.enum';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';
import { AxysEmulationService } from '../infrastructure/providers/axys/axys-emulation.service';
import { CardholderEnrolmentResolver } from './cardholder-enrolment.resolver';
import { CardholderStatusSyncService } from './cardholder-status-sync.service';

@Injectable()
export class EmulateKycValidationUseCase {
  constructor(
    @InjectRepository(CardholderEntity)
    private readonly cardholderRepository: Repository<CardholderEntity>,
    private readonly enrolmentResolver: CardholderEnrolmentResolver,
    private readonly axysEmulationService: AxysEmulationService,
    private readonly statusSyncService: CardholderStatusSyncService,
  ) {}

  async execute(
    cardholderPublicId: string,
    providerKey: CardProviderKey,
    result: 'pass' | 'fail',
  ) {
    const cardholder = await this.cardholderRepository.findOne({
      where: { publicId: cardholderPublicId },
    });
    if (!cardholder) throw new NotFoundException('Cardholder not found');

    const enrolment = await this.enrolmentResolver.require(
      cardholder.id,
      providerKey,
    );
    if (!enrolment.providerCardholderId) {
      throw new ConflictException(
        `Cardholder onboarding with card provider "${providerKey}" has not completed — there is no KYC review to resolve`,
      );
    }

    const idempotencyKey = `kyc-validate-${cardholder.publicId}-${randomBytes(4).toString('hex')}`;
    await this.axysEmulationService.validateKyc(
      enrolment.providerCardholderId,
      result,
      idempotencyKey,
    );

    // Sync immediately rather than waiting for the next 60s reconcile tick —
    // that's the whole point of this being a "force it now" test tool.
    const { enrolment: updated } = await this.statusSyncService.syncOne(
      enrolment,
      CardEventSource.RECONCILE,
    );

    return {
      publicId: cardholder.publicId,
      providerKey: updated.providerKey,
      status: updated.status,
    };
  }
}
