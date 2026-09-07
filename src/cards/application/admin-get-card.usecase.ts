import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { PartnerEntity } from '../../partners/persistence/partner.entity';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';

export interface AdminListCardsInput {
  page: number;
  limit: number;
  status?: CardStatus;
  partnerPublicId?: string;
  cardholderPublicId?: string;
  providerKey?: CardProviderKey;
}

@Injectable()
export class AdminGetCardUseCase {
  constructor(
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    @InjectRepository(CardholderEntity)
    private readonly cardholderRepository: Repository<CardholderEntity>,
    @InjectRepository(PartnerEntity)
    private readonly partnerRepository: Repository<PartnerEntity>,
  ) {}

  async listAll(input: AdminListCardsInput) {
    const { page, limit } = input;
    const where: FindOptionsWhere<CardEntity> = {};
    if (input.status) where.status = input.status;
    if (input.providerKey) where.providerKey = input.providerKey;

    if (input.partnerPublicId) {
      const partner = await this.partnerRepository.findOne({
        where: { publicId: input.partnerPublicId },
        select: { id: true },
      });
      if (!partner) throw new NotFoundException('Partner not found');
      where.partnerId = partner.id;
    }

    if (input.cardholderPublicId) {
      const cardholder = await this.cardholderRepository.findOne({
        where: { publicId: input.cardholderPublicId },
        select: { id: true },
      });
      if (!cardholder) throw new NotFoundException('Cardholder not found');
      where.cardholderId = cardholder.id;
    }

    const [items, total] = await this.cardRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { items, total, page, limit };
  }

  async getByPublicId(publicId: string): Promise<CardEntity> {
    const card = await this.cardRepository.findOne({ where: { publicId } });
    if (!card) throw new NotFoundException('Card not found');
    return card;
  }
}
