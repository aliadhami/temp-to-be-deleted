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
export class PrepareSpendOtpUseCase {
  constructor(
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    private readonly axysEmulationService: AxysEmulationService,
  ) {}

  async execute(cardPublicId: string) {
    const card = await this.cardRepository.findOne({
      where: { publicId: cardPublicId },
    });
    if (!card || !card.providerCardId) {
      throw new NotFoundException('Card not found');
    }

    const idempotencyKey = `spend-otp-${card.publicId}-${randomBytes(4).toString('hex')}`;

    try {
      const result = await this.axysEmulationService.prepareSpendOtp(
        card.providerCardId,
        idempotencyKey,
      );
      return { cardPublicId: card.publicId, pin: result.pin };
    } catch (error) {
      if (error instanceof CardProviderConflictError) {
        // Per Axys docs, this precondition (an active card with a *pending
        // OTP listener*) can never currently be satisfied through this API —
        // there is no operation to register a listener. This 409 is expected
        // on any card today, not a sign of a misconfigured one.
        throw new ConflictException(
          'Card has no pending OTP listener — Axys does not yet expose a way ' +
            'to register one, so this operation cannot succeed on any card today',
        );
      }
      throw error;
    }
  }
}
