import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CardCapability } from '../domain/card-capability.enum';
import { supportsCapability } from '../domain/card-issuer-guards';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardEntity } from '../infrastructure/persistence/card.entity';

@Injectable()
export class GetCardDepositAddressUseCase {
  constructor(
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
  ) {}

  async execute(partnerId: string, publicId: string) {
    const card = await this.cardRepository.findOne({
      where: { publicId, partnerId },
    });
    if (!card || !card.providerCardId) {
      throw new NotFoundException('Card not found');
    }

    const adapter = this.cardIssuerRegistry.resolve(card.providerKey);
    if (!supportsCapability(adapter, CardCapability.DEPOSIT_ADDRESS)) {
      throw new ForbiddenException(
        `Card provider "${card.providerKey}" does not support deposit addresses`,
      );
    }

    const addresses = await adapter.getDepositAddresses(
      card.providerCardId,
      {},
    );

    return { publicId: card.publicId, depositAddresses: addresses };
  }
}
