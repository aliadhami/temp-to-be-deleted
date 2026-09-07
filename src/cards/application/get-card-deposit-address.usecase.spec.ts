import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CardCapability } from '../domain/card-capability.enum';
import { CardIssuerPort } from '../domain/card-issuer.port';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { GetCardDepositAddressUseCase } from './get-card-deposit-address.usecase';

describe('GetCardDepositAddressUseCase', () => {
  let useCase: GetCardDepositAddressUseCase;
  let cardRepository: { findOne: jest.Mock };
  let cardIssuerRegistry: { resolve: jest.Mock };

  const baseCard: Partial<CardEntity> = {
    id: '1',
    publicId: 'card-public-id',
    partnerId: 'partner-1',
    providerKey: CardProviderKey.AXYS,
    providerCardId: 'axys-card-id',
    status: CardStatus.ACTIVE,
  };

  // Typed against the port so the double cannot drift from the interface it
  // stands in for — this story edits CardIssuerPort, so that drift is live.
  type IssuerDouble = Pick<CardIssuerPort, 'capabilities'> & {
    getDepositAddresses: jest.Mock;
  };

  const issuerDouble = (
    capabilities: CardCapability[],
    getDepositAddresses = jest.fn(),
  ): IssuerDouble => ({
    capabilities: new Set(capabilities),
    getDepositAddresses,
  });

  beforeEach(async () => {
    cardRepository = { findOne: jest.fn() };
    cardIssuerRegistry = { resolve: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetCardDepositAddressUseCase,
        { provide: getRepositoryToken(CardEntity), useValue: cardRepository },
        { provide: CardIssuerRegistry, useValue: cardIssuerRegistry },
      ],
    }).compile();

    useCase = module.get(GetCardDepositAddressUseCase);
  });

  it('refuses a provider that declares BALANCE_READ but not DEPOSIT_ADDRESS', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    const double = issuerDouble([CardCapability.BALANCE_READ]);
    cardIssuerRegistry.resolve.mockReturnValueOnce(double);

    // Asserting the message, not just the type: the card-not-found guard above
    // this gate throws too, so the exception class alone proves nothing.
    await expect(
      useCase.execute('partner-1', 'card-public-id'),
    ).rejects.toThrow(
      'Card provider "AXYS" does not support deposit addresses',
    );
    expect(double.getDepositAddresses).not.toHaveBeenCalled();
  });

  it('refuses a provider that declares no capabilities at all', async () => {
    // The shape a scaffolded adapter ships in before its first feature story.
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    const double = issuerDouble([]);
    cardIssuerRegistry.resolve.mockReturnValueOnce(double);

    await expect(
      useCase.execute('partner-1', 'card-public-id'),
    ).rejects.toThrow(ForbiddenException);
    expect(double.getDepositAddresses).not.toHaveBeenCalled();
  });

  it('returns deposit addresses for a provider that declares DEPOSIT_ADDRESS', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    const addresses = [{ chain: 'ETH', address: '0xabc' }];
    const double = issuerDouble(
      [CardCapability.DEPOSIT_ADDRESS],
      jest.fn().mockResolvedValueOnce(addresses),
    );
    cardIssuerRegistry.resolve.mockReturnValueOnce(double);

    const result = await useCase.execute('partner-1', 'card-public-id');

    expect(double.getDepositAddresses).toHaveBeenCalledWith('axys-card-id', {});
    expect(result).toEqual({
      publicId: 'card-public-id',
      depositAddresses: addresses,
    });
  });
});
