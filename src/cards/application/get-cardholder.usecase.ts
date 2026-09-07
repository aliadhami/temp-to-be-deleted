import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardholderStatus } from '../domain/cardholder-status.enum';
import { CardholderEnrolmentEntity } from '../infrastructure/persistence/cardholder-enrolment.entity';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';
import { applyEnrolmentFilter } from './cardholder-enrolment-filter';
import { CardholderEnrolmentResolver } from './cardholder-enrolment.resolver';
import { toCardholderResponse } from './cardholder-projection';

export interface ListCardholdersForPartnerInput {
  partnerId: string;
  page: number;
  limit: number;
  status?: CardholderStatus;
  providerKey?: CardProviderKey;
}

@Injectable()
export class GetCardholderUseCase {
  constructor(
    @InjectRepository(CardholderEntity)
    private readonly cardholderRepository: Repository<CardholderEntity>,
    @InjectRepository(CardholderEnrolmentEntity)
    private readonly enrolmentRepository: Repository<CardholderEnrolmentEntity>,
    private readonly enrolmentResolver: CardholderEnrolmentResolver,
  ) {}

  async execute(partnerId: string, publicId: string) {
    const cardholder = await this.cardholderRepository.findOne({
      where: { publicId, partnerId },
    });
    if (!cardholder) throw new NotFoundException('Cardholder not found');

    return toCardholderResponse(
      cardholder,
      await this.enrolmentResolver.listFor(cardholder.id),
    );
  }

  async listForPartner(input: ListCardholdersForPartnerInput) {
    const { partnerId, page, limit } = input;

    const query = this.cardholderRepository
      .createQueryBuilder('cardholder')
      .where('cardholder.partner_id = :partnerId', { partnerId });
    applyEnrolmentFilter(query, 'cardholder', input);

    const [items, total] = await query
      .orderBy('cardholder.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const enrolments = await this.enrolmentsByCardholder(items);

    return {
      items: items.map((cardholder) =>
        toCardholderResponse(cardholder, enrolments.get(cardholder.id) ?? []),
      ),
      page,
      limit,
      total,
    };
  }

  /** One query for the whole page, rather than one per row. */
  private async enrolmentsByCardholder(
    cardholders: CardholderEntity[],
  ): Promise<Map<string, CardholderEnrolmentEntity[]>> {
    const grouped = new Map<string, CardholderEnrolmentEntity[]>();
    if (cardholders.length === 0) return grouped;

    const rows = await this.enrolmentRepository.find({
      where: { cardholderId: In(cardholders.map((one) => one.id)) },
      order: { createdAt: 'ASC', id: 'ASC' },
    });

    for (const row of rows) {
      const existing = grouped.get(row.cardholderId);
      if (existing) existing.push(row);
      else grouped.set(row.cardholderId, [row]);
    }
    return grouped;
  }
}
