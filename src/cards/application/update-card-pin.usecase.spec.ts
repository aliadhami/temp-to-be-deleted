import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CardCapability } from '../domain/card-capability.enum';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardLifecycleOperationResult } from '../domain/card-issuer.port';
import { CardStatus } from '../domain/card-status.enum';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardEventEntity } from '../infrastructure/persistence/card-event.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { UpdateCardPinUseCase } from './update-card-pin.usecase';

describe('UpdateCardPinUseCase', () => {
  let useCase: UpdateCardPinUseCase;
  let cardRepository: { findOne: jest.Mock; save: jest.Mock };
  let cardEventRepository: { create: jest.Mock; save: jest.Mock };
  let cardIssuerRegistry: { resolve: jest.Mock };

  const adapter = {
    capabilities: new Set([CardCapability.PIN_MANAGEMENT]),
    updateCardPin: jest.fn(),
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
    cardRepository = { findOne: jest.fn(), save: jest.fn() };
    cardEventRepository = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn(),
    };
    cardIssuerRegistry = { resolve: jest.fn(() => adapter) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UpdateCardPinUseCase,
        { provide: getRepositoryToken(CardEntity), useValue: cardRepository },
        {
          provide: getRepositoryToken(CardEventEntity),
          useValue: cardEventRepository,
        },
        { provide: CardIssuerRegistry, useValue: cardIssuerRegistry },
      ],
    }).compile();

    useCase = module.get(UpdateCardPinUseCase);
    jest.clearAllMocks();
    cardIssuerRegistry.resolve.mockReturnValue(adapter);
  });

  it('throws NotFoundException when the card does not belong to this partner', async () => {
    cardRepository.findOne.mockResolvedValueOnce(null);
    await expect(
      useCase.execute('partner-1', 'missing', '0123', '0456'),
    ).rejects.toThrow('Card not found');
  });

  it('throws ForbiddenException when the provider lacks PIN_MANAGEMENT capability', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    cardIssuerRegistry.resolve.mockReturnValueOnce({
      capabilities: new Set(),
      updateCardPin: jest.fn(),
    });
    await expect(
      useCase.execute('partner-1', 'card-public-id', '0123', '0456'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('generates a fresh pin_change_request_id per call and reuses it as the Idempotency-Key', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    adapter.updateCardPin.mockResolvedValueOnce({
      state: 'APPLIED',
      status: CardStatus.ACTIVE,
      operation: 'update_pin',
      updated: true,
    } satisfies CardLifecycleOperationResult);

    await useCase.execute('partner-1', 'card-public-id', '0123', '0456');

    expect(adapter.updateCardPin).toHaveBeenCalledTimes(1);
    const [
      providerCardId,
      pinChangeRequestId,
      oldPin,
      newPin,
      credentials,
      idempotencyKey,
    ] = adapter.updateCardPin.mock.calls[0];

    expect(providerCardId).toBe('axys-card-id');
    expect(pinChangeRequestId).toMatch(
      /^pin-change-card-public-id-[0-9a-f]{8}$/,
    );
    expect(oldPin).toBe('0123');
    expect(newPin).toBe('0456');
    expect(credentials).toEqual({});
    // Same value must reach the adapter twice: once as Axys's body-level
    // pin_change_request_id, once as the transport-level Idempotency-Key.
    expect(idempotencyKey).toBe(pinChangeRequestId);
  });

  it('maps a provider conflict to a ConflictException', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    adapter.updateCardPin.mockRejectedValueOnce(
      new CardProviderConflictError(
        CardProviderKey.AXYS,
        'INVALID_STATE_TRANSITION',
        'bad old pin',
      ),
    );
    await expect(
      useCase.execute('partner-1', 'card-public-id', '0123', '0456'),
    ).rejects.toThrow(ConflictException);
  });

  it('returns the operation result without touching card_event when status is unchanged', async () => {
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    adapter.updateCardPin.mockResolvedValueOnce({
      state: 'APPLIED',
      status: CardStatus.ACTIVE,
      operation: 'update_pin',
      updated: true,
    } satisfies CardLifecycleOperationResult);

    const result = await useCase.execute(
      'partner-1',
      'card-public-id',
      '0123',
      '0456',
    );

    expect(cardRepository.save).not.toHaveBeenCalled();
    expect(cardEventRepository.save).not.toHaveBeenCalled();
    expect(result).toEqual({
      publicId: 'card-public-id',
      status: CardStatus.ACTIVE,
      operation: 'update_pin',
      updated: true,
    });
  });

  it('reports the card where it already is when an issuer only acknowledges the change', async () => {
    // No issuer reaches this today — the one that answers asynchronously does
    // not offer PIN management at all — but the arm exists on the type, and
    // reading a status off it is what the union prevents.
    cardRepository.findOne.mockResolvedValueOnce({ ...baseCard });
    adapter.updateCardPin.mockResolvedValueOnce({
      state: 'SUBMITTED',
      operation: 'update_pin',
      reference: '48d27417-47a4-49b2-968a-91e2523feb22',
    } satisfies CardLifecycleOperationResult);

    const result = await useCase.execute(
      'partner-1',
      'card-public-id',
      '0123',
      '0456',
    );

    // `updated` is absent, not false: false is defined as "the card was
    // already there", which is a claim about an operation the issuer has not
    // carried out.
    expect(result).toEqual({
      publicId: 'card-public-id',
      status: CardStatus.ACTIVE,
      operation: 'update_pin',
    });
    expect(cardRepository.save).not.toHaveBeenCalled();
    expect(cardEventRepository.save).not.toHaveBeenCalled();
  });
});
