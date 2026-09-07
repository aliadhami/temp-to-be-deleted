import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService } from '../../payments/infrastructure/audit/audit.service';
import { CardCapability } from '../domain/card-capability.enum';
import { CardStatus } from '../domain/card-status.enum';
import { SensitiveCardDetails } from '../domain/sensitive-card-details';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardEntity } from '../infrastructure/persistence/card.entity';

@Injectable()
export class RevealSensitiveCardDetailsUseCase {
  constructor(
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
    private readonly auditService: AuditService,
  ) {}

  /**
   * partnerId is mandatory and comes only from an authenticated partner API-
   * key context (PartnerApiKeyGuard) — this method has no code path that can
   * run without it, which is what keeps this reachable only from the partner-
   * facing cardholder reveal flow, never from an internal/admin listing (those
   * never have a partnerId to scope against).
   */
  async execute(
    partnerId: string,
    cardPublicId: string,
  ): Promise<SensitiveCardDetails> {
    const card = await this.cardRepository.findOne({
      where: { publicId: cardPublicId, partnerId },
    });
    if (!card || !card.providerCardId) {
      throw new NotFoundException('Card not found');
    }

    if (card.status === CardStatus.CLOSED) {
      throw new ConflictException(
        'Card is closed — sensitive details cannot be revealed',
      );
    }

    const adapter = this.cardIssuerRegistry.resolve(card.providerKey);
    if (!adapter.capabilities.has(CardCapability.SENSITIVE_REVEAL)) {
      throw new ForbiddenException(
        `Card provider "${card.providerKey}" does not support sensitive detail reveal`,
      );
    }

    let details: SensitiveCardDetails;
    try {
      details = await adapter.revealSensitiveCardDetails(
        card.providerCardId,
        {},
      );
    } catch (error) {
      if (error instanceof CardProviderConflictError) {
        throw new ConflictException(
          'Card is not in a state that allows sensitive detail reveal',
        );
      }
      throw error;
    }

    // Audit every read, per Axys's own PCI documentation ("Audits every
    // read"). Deliberately no card data in afterJson — only who/what/when.
    await this.auditService.record({
      actorUserId: null, // authenticated via partner API key, not a staff user
      action: 'CARD_SENSITIVE_REVEALED',
      targetType: 'card',
      targetPublicId: card.publicId,
      afterJson: { partnerId },
    });

    return details;
  }
}
