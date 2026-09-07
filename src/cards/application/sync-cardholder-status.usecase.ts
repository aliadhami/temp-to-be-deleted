import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CardEventSource } from '../domain/card-event-source.enum';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';
import { CardholderEnrolmentResolver } from './cardholder-enrolment.resolver';
import { CardholderStatusSyncService } from './cardholder-status-sync.service';

@Injectable()
export class SyncCardholderStatusUseCase {
  constructor(
    @InjectRepository(CardholderEntity)
    private readonly cardholderRepository: Repository<CardholderEntity>,
    private readonly enrolmentResolver: CardholderEnrolmentResolver,
    private readonly statusSyncService: CardholderStatusSyncService,
  ) {}

  async execute(cardholderPublicId: string, providerKey: CardProviderKey) {
    const cardholder = await this.cardholderRepository.findOne({
      where: { publicId: cardholderPublicId },
    });
    if (!cardholder) throw new NotFoundException('Cardholder not found');

    const enrolment = await this.enrolmentResolver.require(
      cardholder.id,
      providerKey,
    );

    const previousStatus = enrolment.status;
    const { enrolment: updated, queried } =
      await this.statusSyncService.syncOne(
        enrolment,
        CardEventSource.RECONCILE,
      );

    return {
      publicId: cardholder.publicId,
      providerKey: updated.providerKey,
      providerCardholderId: updated.providerCardholderId,
      previousLocalStatus: previousStatus,
      // Only ever the provider's own answer. An issuer that reports no
      // person-level status is not asked at all, and publishing the stored
      // value here would present it as one they gave.
      liveProviderStatus: queried ? updated.status : null,
      providerQueried: queried,
      changed: previousStatus !== updated.status,
    };
  }
}
