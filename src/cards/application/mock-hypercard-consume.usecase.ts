import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import {
  HyperCardMockConsumeInput,
  HyperCardMockService,
} from '../infrastructure/providers/hypercard/hypercard-mock.service';

/** Obviously synthetic: their statement returns it for ever. */
const DEFAULT_DESCRIPTION = 'admin emulation';

const DEFAULT_FEE = '0.00';

export interface MockHyperCardConsumeInput {
  amount: string;
  amountUsd?: string;
  description?: string;
  fee?: string;
  transactionDate?: string;
  type?: number;
  status?: number;
}

/** Invents a transaction on a HyperCard card, which their `CONSUME` push then announces. */
@Injectable()
export class MockHyperCardConsumeUseCase {
  constructor(
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    private readonly mockService: HyperCardMockService,
  ) {}

  async execute(cardPublicId: string, input: MockHyperCardConsumeInput) {
    const card = await this.cardRepository.findOne({
      where: { publicId: cardPublicId },
    });
    if (!card) {
      throw new NotFoundException('Card not found');
    }

    // Before the card-id check below, so a card of another issuer is named as
    // such even when it has not been issued yet.
    if (card.providerKey !== CardProviderKey.HYPERCARD) {
      throw new BadRequestException(
        `Card is issued by ${card.providerKey}; this route drives HyperCard's sandbox only`,
      );
    }

    if (!card.providerCardId) {
      throw new NotFoundException('Card not found');
    }

    const amountUsd = input.amountUsd ?? input.amount;
    const description = input.description ?? DEFAULT_DESCRIPTION;
    const fee = input.fee ?? DEFAULT_FEE;
    const transactionDate =
      input.transactionDate ?? Math.floor(Date.now() / 1000).toString();

    const request: HyperCardMockConsumeInput = {
      cardId: card.providerCardId,
      description,
      fee,
      transactionDate,
      // Decimal strings, never JS numbers, all the way to their wire.
      txAmount: input.amount,
      txAmountUsd: amountUsd,
      // Omitted rather than defaulted: their defaults live in the service.
      ...(input.type === undefined ? {} : { type: input.type }),
      ...(input.status === undefined ? {} : { status: input.status }),
    };

    try {
      const result = await this.mockService.mockTxConsume(request);

      return {
        cardPublicId: card.publicId,
        amount: input.amount,
        amountUsd,
        description,
        fee,
        transactionDate,
        type: result.type,
        status: result.status,
      };
    } catch (error) {
      if (error instanceof CardProviderConflictError) {
        throw new ConflictException(
          'HyperCard refused to invent a transaction on this card — a frozen card is the usual reason',
        );
      }
      throw error;
    }
  }
}
