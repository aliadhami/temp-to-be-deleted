import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PartnerEntity } from '../../partners/persistence/partner.entity';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';
import { CardholderEnrolmentService } from './cardholder-enrolment.service';

export interface EnrolCardholderInput {
  partnerId: string;
  cardholderPublicId: string;
  providerKey: CardProviderKey;
}

/** Puts a person this partner already holds to a further issuer. */
@Injectable()
export class EnrolCardholderUseCase {
  constructor(
    @InjectRepository(CardholderEntity)
    private readonly cardholderRepository: Repository<CardholderEntity>,
    @InjectRepository(PartnerEntity)
    private readonly partnerRepository: Repository<PartnerEntity>,
    private readonly enrolmentService: CardholderEnrolmentService,
  ) {}

  async execute(input: EnrolCardholderInput) {
    const cardholder = await this.cardholderRepository.findOne({
      where: { publicId: input.cardholderPublicId, partnerId: input.partnerId },
    });
    if (!cardholder) throw new NotFoundException('Cardholder not found');

    const partner = await this.partnerRepository.findOne({
      where: { id: input.partnerId },
    });
    if (!partner) throw new NotFoundException('Partner not found');

    const { enrolment, kycUrl } = await this.enrolmentService.enrol(
      cardholder,
      partner,
      input.providerKey,
    );

    return {
      publicId: cardholder.publicId,
      providerKey: enrolment.providerKey,
      status: enrolment.status,
      ...(kycUrl && { kycUrl }),
    };
  }
}
