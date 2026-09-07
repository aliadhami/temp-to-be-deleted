import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CardCapability } from '../domain/card-capability.enum';
import { ListCardTransactionsParams } from '../domain/card-issuer.port';
import { CardProviderIntentRejectedError } from '../domain/card-provider-intent-rejected.error';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardEntity } from '../infrastructure/persistence/card.entity';

@Injectable()
export class ListCardTransactionsUseCase {
  constructor(
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
  ) {}

  async execute(
    partnerId: string,
    cardPublicId: string,
    params: ListCardTransactionsParams,
  ) {
    const card = await this.cardRepository.findOne({
      where: { publicId: cardPublicId, partnerId },
    });
    if (!card || !card.providerCardId) {
      throw new NotFoundException('Card not found');
    }

    const adapter = this.cardIssuerRegistry.resolve(card.providerKey);
    if (!adapter.capabilities.has(CardCapability.TRANSACTIONS_READ)) {
      throw new ForbiddenException(
        `Card provider "${card.providerKey}" does not support transaction history`,
      );
    }

    const result = await this.fetch(adapter, card.providerCardId, params);

    return { cardPublicId: card.publicId, ...result };
  }

  /**
   * The provider call, with the one refusal a partner can act on translated.
   */
  private async fetch(
    adapter: ReturnType<CardIssuerRegistry['resolve']>,
    providerCardId: string,
    params: ListCardTransactionsParams,
  ) {
    try {
      return await adapter.getCardTransactions(providerCardId, params, {});
    } catch (error) {
      if (error instanceof CardProviderIntentRejectedError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
