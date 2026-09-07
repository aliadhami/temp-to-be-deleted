import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { AxysEmulationService } from '../infrastructure/providers/axys/axys-emulation.service';

@Injectable()
export class SimulateCardDepositUseCase {
  constructor(
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    private readonly axysEmulationService: AxysEmulationService,
  ) {}

  /**
   * cardPublicId is required so this stays scoped to a known local card (and
   * shows up in admin tooling attached to that card), but Axys's own
   * simulate-crypto-deposit call is keyed on the address alone — the caller
   * must pass the exact address obtained from GET .../deposit-address, since
   * a card can have more than one address (one per chain).
   */
  async execute(
    cardPublicId: string,
    address: string,
    tokenId: string,
    amount: string,
  ) {
    const card = await this.cardRepository.findOne({
      where: { publicId: cardPublicId },
    });
    if (!card || !card.providerCardId) {
      throw new NotFoundException('Card not found');
    }

    const idempotencyKey = `deposit-${card.publicId}-${randomBytes(4).toString('hex')}`;
    const result = await this.axysEmulationService.simulateCryptoDeposit(
      address,
      tokenId,
      amount,
      idempotencyKey,
    );

    return {
      cardPublicId: card.publicId,
      address,
      amount,
      txId: result.txId,
    };
  }
}
