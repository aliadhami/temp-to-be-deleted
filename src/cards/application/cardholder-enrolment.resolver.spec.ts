import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardholderStatus } from '../domain/cardholder-status.enum';
import { CardholderEnrolmentEntity } from '../infrastructure/persistence/cardholder-enrolment.entity';
import { CardholderEnrolmentResolver } from './cardholder-enrolment.resolver';

describe('CardholderEnrolmentResolver', () => {
  let resolver: CardholderEnrolmentResolver;
  let enrolmentRepository: { findOne: jest.Mock; find: jest.Mock };

  beforeEach(async () => {
    enrolmentRepository = { findOne: jest.fn(), find: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CardholderEnrolmentResolver,
        {
          provide: getRepositoryToken(CardholderEnrolmentEntity),
          useValue: enrolmentRepository,
        },
      ],
    }).compile();

    resolver = module.get(CardholderEnrolmentResolver);
    jest.clearAllMocks();
  });

  it('returns the enrolment for the issuer that was named', async () => {
    const row = {
      id: '11',
      providerKey: CardProviderKey.AXYS,
      status: CardholderStatus.APPROVED,
    };
    enrolmentRepository.findOne.mockResolvedValueOnce(row);

    await expect(resolver.require('7', CardProviderKey.AXYS)).resolves.toBe(
      row,
    );
    expect(enrolmentRepository.findOne).toHaveBeenCalledWith({
      where: { cardholderId: '7', providerKey: CardProviderKey.AXYS },
    });
  });

  it('refuses an issuer this person was never put to', async () => {
    // A 409 rather than a 404: the person and the issuer both exist, and the
    // caller can create the relationship that is missing.
    enrolmentRepository.findOne.mockResolvedValueOnce(null);

    const error: unknown = await resolver
      .require('7', CardProviderKey.HYPERCARD)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toContain('HYPERCARD');
  });

  it('does not answer one issuer with another issuer’s enrolment', async () => {
    // The whole point of the split: an approval Axys gave says nothing about
    // HyperCard, so the lookup is keyed on both the person and the issuer.
    enrolmentRepository.findOne.mockResolvedValueOnce(null);

    await expect(
      resolver.require('7', CardProviderKey.HYPERCARD),
    ).rejects.toThrow(ConflictException);
  });

  it('lists every issuer this person has been put to, oldest first', async () => {
    enrolmentRepository.find.mockResolvedValueOnce([]);

    await resolver.listFor('7');

    expect(enrolmentRepository.find).toHaveBeenCalledWith({
      where: { cardholderId: '7' },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  });
});
