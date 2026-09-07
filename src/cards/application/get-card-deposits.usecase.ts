import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CardDepositListResponseDto,
  CardDepositResponseDto,
} from '../api/dto/card-deposit-response.dto';
import { CardDepositStatus } from '../domain/card-deposit-status.enum';
import { CardDepositEntity } from '../infrastructure/persistence/card-deposit.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { toCardDepositResponse } from './card-deposit-projection';

/**
 * Reads a card's deposits back — the collection and one member. Published as a
 * resource rather than kept as a private row, because `card_deposit` is the
 * only place a deposit's whole lifecycle exists.
 */
@Injectable()
export class GetCardDepositsUseCase {
  constructor(
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    @InjectRepository(CardDepositEntity)
    private readonly depositRepository: Repository<CardDepositEntity>,
  ) {}

  async listForCard(
    partnerId: string,
    cardPublicId: string,
    page: number,
    limit: number,
    status?: CardDepositStatus,
  ): Promise<CardDepositListResponseDto> {
    const card = await this.resolveCard(partnerId, cardPublicId);

    const where: Record<string, unknown> = { cardId: card.id };
    if (status) where.status = status;

    const [items, total] = await this.depositRepository.findAndCount({
      where,
      // Newest first, matching every other list in this API. The index leading
      // on the card orders these without a sort.
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { items: items.map(toCardDepositResponse), page, limit, total };
  }

  async getOne(
    partnerId: string,
    cardPublicId: string,
    depositPublicId: string,
  ): Promise<CardDepositResponseDto> {
    const card = await this.resolveCard(partnerId, cardPublicId);

    const deposit = await this.depositRepository.findOne({
      // Scoped to the card in the query, so a deposit on somebody else's card
      // is a 404 rather than a row that leaks through a guessed identifier.
      where: { publicId: depositPublicId, cardId: card.id },
    });
    if (!deposit) throw new NotFoundException('Card deposit not found');

    return toCardDepositResponse(deposit);
  }

  /**
   * The card, scoped to the partner who asked. A card belonging to another
   * partner is a 404, never a 403 — the scoping is in the query, so "not
   * yours" and "does not exist" are deliberately the same answer.
   */
  private async resolveCard(
    partnerId: string,
    cardPublicId: string,
  ): Promise<CardEntity> {
    const card = await this.cardRepository.findOne({
      where: { publicId: cardPublicId, partnerId },
      select: { id: true },
    });
    if (!card) throw new NotFoundException('Card not found');

    return card;
  }
}
