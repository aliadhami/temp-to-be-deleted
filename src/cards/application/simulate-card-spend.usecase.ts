import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { AxysEmulationService } from '../infrastructure/providers/axys/axys-emulation.service';

@Injectable()
export class SimulateCardSpendUseCase {
  constructor(
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    private readonly axysEmulationService: AxysEmulationService,
  ) {}

  async execute(cardPublicId: string, amount: string) {
    const card = await this.cardRepository.findOne({
      where: { publicId: cardPublicId },
    });
    if (!card || !card.providerCardId) {
      throw new NotFoundException('Card not found');
    }

    const idempotencyKey = `spend-${card.publicId}-${randomBytes(4).toString('hex')}`;

    try {
      await this.axysEmulationService.simulateSpend(
        card.providerCardId,
        amount,
        idempotencyKey,
      );
      return { cardPublicId: card.publicId, amount };
    } catch (error) {
      if (error instanceof CardProviderConflictError) {
        throw new ConflictException(
          'Card is not in a state that allows a simulated spend (must be active and sufficiently funded)',
        );
      }
      throw error;
    }
  }
}
