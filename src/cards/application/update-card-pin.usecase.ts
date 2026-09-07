import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { CardCapability } from '../domain/card-capability.enum';
import { CardEventSource } from '../domain/card-event-source.enum';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardEventEntity } from '../infrastructure/persistence/card-event.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';

@Injectable()
export class UpdateCardPinUseCase {
  constructor(
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    @InjectRepository(CardEventEntity)
    private readonly cardEventRepository: Repository<CardEventEntity>,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
  ) {}

  async execute(
    partnerId: string,
    cardPublicId: string,
    oldPin: string,
    newPin: string,
  ) {
    const card = await this.cardRepository.findOne({
      where: { publicId: cardPublicId, partnerId },
    });
    if (!card || !card.providerCardId) {
      throw new NotFoundException('Card not found');
    }

    const adapter = this.cardIssuerRegistry.resolve(card.providerKey);
    if (!adapter.capabilities.has(CardCapability.PIN_MANAGEMENT)) {
      throw new ForbiddenException(
        `Card provider "${card.providerKey}" does not support PIN management`,
      );
    }

    const pinChangeRequestId = `pin-change-${card.publicId}-${randomBytes(4).toString('hex')}`;

    let result;
    try {
      result = await adapter.updateCardPin(
        card.providerCardId,
        pinChangeRequestId,
        oldPin,
        newPin,
        {},
        pinChangeRequestId,
      );
    } catch (error) {
      if (error instanceof CardProviderConflictError) {
        throw new ConflictException(
          'Card is not in a state that allows a PIN change, or the current PIN is incorrect',
        );
      }
      throw error;
    }

    // The submitted arm carries no card status, so there is nothing to write
    // and nothing to report but where the card already is. Unreached today:
    // the issuer that answers asynchronously offers no PIN management.
    if (result.state !== 'APPLIED') {
      // `updated` is omitted rather than false, which the port defines as "the
      // card was already there" — a claim about an operation the issuer has
      // not carried out.
      return {
        publicId: card.publicId,
        status: card.status,
        operation: result.operation,
      };
    }

    if (result.status !== card.status) {
      const previousStatus = card.status;
      card.status = result.status;
      await this.cardRepository.save(card);

      await this.cardEventRepository.save(
        this.cardEventRepository.create({
          cardId: card.id,
          fromStatus: previousStatus,
          toStatus: result.status,
          source: CardEventSource.MANUAL,
          detail: 'PIN updated',
        }),
      );
    }

    return {
      publicId: card.publicId,
      status: result.status,
      operation: result.operation,
      updated: result.updated,
    };
  }
}
