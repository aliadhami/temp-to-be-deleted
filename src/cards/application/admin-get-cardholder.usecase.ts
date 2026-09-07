import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PartnerEntity } from '../../partners/persistence/partner.entity';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardholderStatus } from '../domain/cardholder-status.enum';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';
import { applyEnrolmentFilter } from './cardholder-enrolment-filter';

export interface AdminListCardholdersInput {
  page: number;
  limit: number;
  status?: CardholderStatus;
  partnerPublicId?: string;
  providerKey?: CardProviderKey;
}

@Injectable()
export class AdminGetCardholderUseCase {
  constructor(
    @InjectRepository(CardholderEntity)
    private readonly cardholderRepository: Repository<CardholderEntity>,
    @InjectRepository(PartnerEntity)
    private readonly partnerRepository: Repository<PartnerEntity>,
  ) {}

  async listAll(input: AdminListCardholdersInput) {
    const { page, limit } = input;

    const query = this.cardholderRepository
      .createQueryBuilder('cardholder')
      .leftJoinAndSelect('cardholder.enrolments', 'enrolments');
    applyEnrolmentFilter(query, 'cardholder', input);

    if (input.partnerPublicId) {
      const partner = await this.partnerRepository.findOne({
        where: { publicId: input.partnerPublicId },
        select: { id: true },
      });
      if (!partner) throw new NotFoundException('Partner not found');
      query.andWhere('cardholder.partner_id = :partnerId', {
        partnerId: partner.id,
      });
    }

    const [items, total] = await query
      .orderBy('cardholder.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { items, total, page, limit };
  }

  async getByPublicId(publicId: string): Promise<CardholderEntity> {
    const cardholder = await this.cardholderRepository.findOne({
      where: { publicId },
      relations: { enrolments: true },
    });
    if (!cardholder) throw new NotFoundException('Cardholder not found');
    return cardholder;
  }
}
