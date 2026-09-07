import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PartnerEntity } from '../../partners/persistence/partner.entity';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import {
  IdentityProvenance,
  ResidentialAddress,
} from '../domain/cardholder-intent.model';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';
import { CardholderEnrolmentService } from './cardholder-enrolment.service';

export interface OnboardCardholderInput {
  partnerId: string;
  providerKey: CardProviderKey;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  residentialAddress: ResidentialAddress;
  identityProvenance: IdentityProvenance;
  userIp?: string;
}

/**
 * Records a person and puts them to their first issuer. Nothing dedupes people
 * — two calls carrying the same identity make two cardholders, each with their
 * own enrolments.
 */
@Injectable()
export class OnboardCardholderUseCase {
  constructor(
    @InjectRepository(CardholderEntity)
    private readonly cardholderRepository: Repository<CardholderEntity>,
    @InjectRepository(PartnerEntity)
    private readonly partnerRepository: Repository<PartnerEntity>,
    private readonly enrolmentService: CardholderEnrolmentService,
  ) {}

  async execute(input: OnboardCardholderInput) {
    const partner = await this.partnerRepository.findOne({
      where: { id: input.partnerId },
    });
    if (!partner) throw new NotFoundException('Partner not found');

    // Before the person is written, not after. A refusal below the insert
    // leaves a cardholder with no enrolment — unreachable through every read,
    // swept by nothing, and holding the identity material the partner sent.
    this.enrolmentService.assertCanEnrol(partner, input.providerKey);

    // Normalised once, so the column and the adapter cannot disagree about what
    // absence means: a blank string is neither stored nor forwarded.
    const userIp = input.userIp?.trim() || null;

    const cardholder = await this.cardholderRepository.save(
      this.cardholderRepository.create({
        partnerId: input.partnerId,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        dateOfBirth: input.dateOfBirth,
        residentialAddress: input.residentialAddress,
        identityProvenance: input.identityProvenance,
        userIp,
      }),
    );

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
