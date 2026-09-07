import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardholderEnrolmentEntity } from '../infrastructure/persistence/cardholder-enrolment.entity';

@Injectable()
export class CardholderEnrolmentResolver {
  constructor(
    @InjectRepository(CardholderEnrolmentEntity)
    private readonly enrolmentRepository: Repository<CardholderEnrolmentEntity>,
  ) {}

  /**
   * The person's standing with one issuer. A 409 rather than a 404: the person
   * exists and the issuer exists, and what is missing is a relationship the
   * caller can create.
   */
  async require(
    cardholderId: string,
    providerKey: CardProviderKey,
  ): Promise<CardholderEnrolmentEntity> {
    const enrolment = await this.enrolmentRepository.findOne({
      where: { cardholderId, providerKey },
    });

    if (!enrolment) {
      throw new ConflictException(
        `Cardholder is not enrolled with card provider "${providerKey}" — enrol them with it first`,
      );
    }

    return enrolment;
  }

  /** Every issuer this person has been put to, oldest first. */
  listFor(cardholderId: string): Promise<CardholderEnrolmentEntity[]> {
    return this.enrolmentRepository.find({
      where: { cardholderId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }
}
