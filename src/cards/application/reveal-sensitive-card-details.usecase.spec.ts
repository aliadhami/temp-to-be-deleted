import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditService } from '../../payments/infrastructure/audit/audit.service';
import { CardCapability } from '../domain/card-capability.enum';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { SensitiveCardDetails } from '../domain/sensitive-card-details';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { RevealSensitiveCardDetailsUseCase } from './reveal-sensitive-card-details.usecase';

describe('RevealSensitiveCardDetailsUseCase', () => {
  let useCase: RevealSensitiveCardDetailsUseCase;
  let cardRepository: { findOne: jest.Mock };
  let cardIssuerRegistry: { resolve: jest.Mock };
  let auditService: { record: jest.Mock };

  const adapter = {
    capabilities: new Set([CardCapability.SENSITIVE_REVEAL]),
    revealSensitiveCardDetails: jest.fn(),
  };

  const baseCard: Partial<CardEntity> = {
    id: '1',
    publicId: 'card-public-id',
    partnerId: 'partner-1',
    providerKey: CardProviderKey.AXYS,
    providerCardId: 'axys-card-id',
    status: CardStatus.ACTIVE,
  };

  beforeEach(async () => {
    cardRepository = { findOne: jest.fn() };
    cardIssuerRegistry = { resolve: jest.fn(() => adapter) };
    auditService = { record: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RevealSensitiveCardDetailsUseCase,
        { provide: getRepositoryToken(CardEntity), useValue: cardRepository },
        { provide: CardIssuerRegistry, useValue: cardIssuerRegistry },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    useCase = module.get(RevealSensitiveCardDetailsUseCase);
    jest.clearAllMocks();
    cardIssuerRegistry.resolve.mockReturnValue(adapter);
  });

  it('throws NotFoundException when the card does not belong to this partner', async () => {
    cardRepository.findOne.mockResolvedValueOnce(null);
    await expect(useCase.execute('partner-1', 'missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws ConflictException for a closed card without ever calling the provider', async () => {
    cardRepository.findOne.mockResolvedValueOnce({
      ...baseCard,
      status: CardStatus.CLOSED,
    });
    await expect(
      useCase.execute('partner-1', 'card-public-id'),
    ).rejects.toThrow(ConflictException);
    expect(adapter.revealSensitiveCardDetails).not.toHaveBeenCalled();
  });

  it('throws ForbiddenException when the provider lacks SENSITIVE_REVEAL capability', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    cardIssuerRegistry.resolve.mockReturnValueOnce({
      capabilities: new Set(),
      revealSensitiveCardDetails: jest.fn(),
    });
    await expect(
      useCase.execute('partner-1', 'card-public-id'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('maps a provider conflict to a ConflictException', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    adapter.revealSensitiveCardDetails.mockRejectedValueOnce(
      new CardProviderConflictError(
        CardProviderKey.AXYS,
        'CARD_NOT_ACTIVE',
        'card not active',
      ),
    );
    await expect(
      useCase.execute('partner-1', 'card-public-id'),
    ).rejects.toThrow(ConflictException);
  });

  it('re-throws non-409 errors unchanged', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    adapter.revealSensitiveCardDetails.mockRejectedValueOnce(
      new Error('network blip'),
    );
    await expect(
      useCase.execute('partner-1', 'card-public-id'),
    ).rejects.toThrow('network blip');
  });

  it('returns the wrapped details and records an audit event with no card data in it', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    const wrapped = new SensitiveCardDetails({
      kind: 'FULL',
      maskedPan: '************4242',
      cvv: '999',
      expiryMonth: 8,
      expiryYear: 2029,
    });
    adapter.revealSensitiveCardDetails.mockResolvedValueOnce(wrapped);

    const result = await useCase.execute('partner-1', 'card-public-id');

    expect(result).toBe(wrapped);
    expect(auditService.record).toHaveBeenCalledTimes(1);
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CARD_SENSITIVE_REVEALED',
        targetType: 'card',
        targetPublicId: 'card-public-id',
        afterJson: { partnerId: 'partner-1' },
      }),
    );
    // Confirm the audit call genuinely never received the sensitive object.
    const auditArg = (
      auditService.record.mock.calls as unknown as unknown[][]
    )[0]?.[0];
    expect(JSON.stringify(auditArg)).not.toContain('999');
  });
});
