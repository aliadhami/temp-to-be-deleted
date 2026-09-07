import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IsNull, QueryFailedError } from 'typeorm';
import { WebhookDeliveryService } from '../../payments/infrastructure/webhooks/webhook-delivery.service';
import { CardCapability } from '../domain/card-capability.enum';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { CardProviderIntentRejectedError } from '../domain/card-provider-intent-rejected.error';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardActivationStatus } from '../domain/card-activation-status.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardEventEntity } from '../infrastructure/persistence/card-event.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import {
  ActivateCardInput,
  ActivateCardUseCase,
} from './activate-card.usecase';

describe('ActivateCardUseCase', () => {
  let useCase: ActivateCardUseCase;
  let cardRepository: { findOne: jest.Mock; update: jest.Mock };
  let eventRepository: { create: jest.Mock; save: jest.Mock };
  let cardIssuerRegistry: { resolve: jest.Mock };
  let webhookDeliveryService: { enqueueForCard: jest.Mock };

  const adapter = {
    // Both flags, because this double stands in for an issuer that
    // acknowledges an activation and settles it afterwards — the outstanding
    // attempt is only recorded where something can later be asked what became
    // of it.
    capabilities: new Set([
      CardCapability.ACTIVATE,
      CardCapability.APPLICATION_RESULT,
    ]),
    activateCard: jest.fn(),
  };

  const input: ActivateCardInput = {
    partnerId: 'partner-1',
    cardPublicId: 'card-1',
    pan: '4249040000004589',
    expiryMonth: 12,
    expiryYear: 2030,
    cvv: '123',
    pin: '1234',
  };

  beforeEach(async () => {
    cardRepository = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    eventRepository = { create: jest.fn((x: unknown) => x), save: jest.fn() };
    cardIssuerRegistry = { resolve: jest.fn(() => adapter) };
    webhookDeliveryService = { enqueueForCard: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActivateCardUseCase,
        { provide: getRepositoryToken(CardEntity), useValue: cardRepository },
        {
          provide: getRepositoryToken(CardEventEntity),
          useValue: eventRepository,
        },
        { provide: CardIssuerRegistry, useValue: cardIssuerRegistry },
        {
          provide: WebhookDeliveryService,
          useValue: webhookDeliveryService,
        },
      ],
    }).compile();

    useCase = module.get(ActivateCardUseCase);
    jest.clearAllMocks();
    cardIssuerRegistry.resolve.mockReturnValue(adapter);
    cardRepository.update.mockResolvedValue({ affected: 1 });
    cardRepository.findOne.mockResolvedValue({
      id: '1',
      publicId: 'card-1',
      partnerId: 'partner-1',
      providerKey: CardProviderKey.AXYS,
      providerCardId: 'axys-card-1',
      status: CardStatus.NOT_ACTIVATED,
      activationStatus: null,
      activationReasonCode: null,
      activationReason: null,
    });
  });

  it('throws ForbiddenException when the provider cannot activate', async () => {
    const stub = { capabilities: new Set(), activateCard: jest.fn() };
    cardIssuerRegistry.resolve.mockReturnValueOnce(stub);

    await expect(useCase.execute(input)).rejects.toThrow(ForbiddenException);
    expect(stub.activateCard).not.toHaveBeenCalled();
  });

  it('activates when the capability is declared', async () => {
    adapter.activateCard.mockResolvedValueOnce({ status: CardStatus.ACTIVE });

    await useCase.execute(input);

    expect(adapter.activateCard).toHaveBeenCalled();
  });

  it('passes only the fields the request actually carried', async () => {
    // Under `exactOptionalPropertyTypes` an absent optional and one set to
    // undefined are different things, and each adapter decides which of these
    // it needs — so a field nobody sent must arrive absent rather than as a
    // null the adapter would have to interpret.
    adapter.activateCard.mockResolvedValueOnce({ status: CardStatus.ACTIVE });

    await useCase.execute({
      partnerId: 'partner-1',
      cardPublicId: 'card-1',
      activationDocument: 'aGVsbG8=',
    });

    expect(adapter.activateCard).toHaveBeenNthCalledWith(
      1,
      {
        cardPublicId: 'card-1',
        providerCardId: 'axys-card-1',
        activationDocument: 'aGVsbG8=',
      },
      {},
      'activate-card-1',
    );
  });

  it('treats an explicit null as a field that was not supplied', async () => {
    // The request DTO marks every one of these optional, and that skips
    // validation for an explicit null as well as for an absent key.
    adapter.activateCard.mockResolvedValueOnce({ status: CardStatus.ACTIVE });

    await useCase.execute({
      partnerId: 'partner-1',
      cardPublicId: 'card-1',
      pan: null,
      expiryMonth: null,
      activationDocument: 'aGVsbG8=',
    });

    expect(adapter.activateCard).toHaveBeenNthCalledWith(
      1,
      {
        cardPublicId: 'card-1',
        providerCardId: 'axys-card-1',
        activationDocument: 'aGVsbG8=',
      },
      {},
      'activate-card-1',
    );
  });

  describe('announcing the activation', () => {
    it('tells the partner when the issuer returns a usable card', async () => {
      adapter.activateCard.mockResolvedValueOnce({ status: CardStatus.ACTIVE });

      await useCase.execute(input);

      expect(webhookDeliveryService.enqueueForCard).toHaveBeenNthCalledWith(
        1,
        '1',
        'partner-1',
        'card.activated',
        expect.objectContaining({ status: CardStatus.ACTIVE }),
      );
    });

    it('stays silent when the issuer has only acknowledged the request', async () => {
      // An issuer that acknowledges and settles afterwards leaves the card at
      // its own activating state. Announcing here would tell a partner the card
      // is usable while it is not, and the sweep that watches an opened card
      // would then send a second, correct event for the same card.
      adapter.activateCard.mockResolvedValueOnce({
        status: CardStatus.NOT_ACTIVATED,
      });

      await useCase.execute(input);

      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
    });

    it('records the attempt even when the status did not move', async () => {
      // For an issuer whose card does not change state on the call, these two
      // writes are the whole record that activation was requested and
      // accepted: the event for the history, the stamp for what a partner
      // reads back.
      adapter.activateCard.mockResolvedValueOnce({
        status: CardStatus.NOT_ACTIVATED,
      });

      await useCase.execute(input);

      expect(eventRepository.save).toHaveBeenCalledTimes(1);
      // The predicate names the activation this request read, not only the
      // status — for this issuer the status does not move, so a predicate
      // without it matches every racer alike.
      expect(cardRepository.update).toHaveBeenNthCalledWith(
        1,
        {
          id: '1',
          status: CardStatus.NOT_ACTIVATED,
          activationStatus: IsNull(),
        },
        {
          activationStatus: CardActivationStatus.PENDING,
          activationReasonCode: null,
          activationReason: null,
        },
      );
    });

    it('reports the outstanding attempt in its own answer', async () => {
      // The status is unmoved and cannot say whether the request landed, so a
      // caller that had only that would have to poll to find out.
      adapter.activateCard.mockResolvedValueOnce({
        status: CardStatus.NOT_ACTIVATED,
      });

      await expect(useCase.execute(input)).resolves.toEqual({
        publicId: 'card-1',
        status: CardStatus.NOT_ACTIVATED,
        activationStatus: CardActivationStatus.PENDING,
      });
    });

    it('stamps nothing outstanding for an issuer nothing can ask about afterwards', async () => {
      // Only the status sweep clears this column, and it examines a card only
      // where the issuer can be asked what became of its application. A stamp
      // written for an issuer that cannot be asked would never come off, and
      // the guard above would then refuse every later attempt for ever.
      const unaskable = {
        capabilities: new Set([CardCapability.ACTIVATE]),
        activateCard: jest
          .fn()
          .mockResolvedValue({ status: CardStatus.NOT_ACTIVATED }),
      };
      cardIssuerRegistry.resolve.mockReturnValue(unaskable);

      await expect(useCase.execute(input)).resolves.toEqual({
        publicId: 'card-1',
        status: CardStatus.NOT_ACTIVATED,
        activationStatus: null,
      });

      expect(cardRepository.update).not.toHaveBeenCalled();
    });

    it('stamps nothing outstanding when the issuer activated the card outright', async () => {
      // An issuer that settles on the call has nothing left to wait for, and a
      // pending stamp on an active card would be read as one.
      adapter.activateCard.mockResolvedValueOnce({ status: CardStatus.ACTIVE });

      await expect(useCase.execute(input)).resolves.toEqual({
        publicId: 'card-1',
        status: CardStatus.ACTIVE,
        activationStatus: null,
      });
    });
  });

  describe('refusing a card that cannot be activated', () => {
    it.each([CardStatus.ACTIVE, CardStatus.ON_HOLD, CardStatus.CLOSED])(
      'refuses a %s card without calling the provider',
      async (status) => {
        // The downgrade this prevents is the reason it exists.
        cardRepository.findOne.mockResolvedValueOnce({
          id: '1',
          publicId: 'card-1',
          partnerId: 'partner-1',
          providerKey: CardProviderKey.HYPERCARD,
          providerCardId: 'hc-card-1',
          status,
        });

        await expect(useCase.execute(input)).rejects.toBeInstanceOf(
          ConflictException,
        );

        expect(adapter.activateCard).not.toHaveBeenCalled();
        expect(cardRepository.update).not.toHaveBeenCalled();
        expect(eventRepository.save).not.toHaveBeenCalled();
      },
    );

    it('still allows a retry after the issuer refused an activation', async () => {
      // Their activation-failure states map back to a not-activated card, so a
      // corrected second attempt is exactly the case that must go through.
      adapter.activateCard.mockResolvedValueOnce({
        status: CardStatus.NOT_ACTIVATED,
      });

      await expect(useCase.execute(input)).resolves.toEqual({
        publicId: 'card-1',
        status: CardStatus.NOT_ACTIVATED,
        activationStatus: CardActivationStatus.PENDING,
      });
    });

    it('refuses a second request while one is still with the issuer', async () => {
      // The issuer is reviewing the document it already has; a second would
      // leave it holding two for one card with no way to say which answer
      // belongs to which.
      cardRepository.findOne.mockResolvedValueOnce({
        id: '1',
        publicId: 'card-1',
        partnerId: 'partner-1',
        providerKey: CardProviderKey.HYPERCARD,
        providerCardId: 'hc-card-1',
        status: CardStatus.NOT_ACTIVATED,
        activationStatus: CardActivationStatus.PENDING,
        activationReasonCode: null,
        activationReason: null,
      });

      await expect(useCase.execute(input)).rejects.toThrow(ConflictException);

      expect(adapter.activateCard).not.toHaveBeenCalled();
      expect(cardRepository.update).not.toHaveBeenCalled();
    });

    it('accepts a corrected attempt after the issuer refused one, clearing its reason', async () => {
      cardRepository.findOne.mockResolvedValueOnce({
        id: '1',
        publicId: 'card-1',
        partnerId: 'partner-1',
        providerKey: CardProviderKey.HYPERCARD,
        providerCardId: 'hc-card-1',
        status: CardStatus.NOT_ACTIVATED,
        activationStatus: CardActivationStatus.FAILED,
        activationReasonCode: 'E0003',
        activationReason: 'Incorrect activation photo',
      });
      adapter.activateCard.mockResolvedValueOnce({
        status: CardStatus.NOT_ACTIVATED,
      });

      await useCase.execute(input);

      // Why the old reason has to go: it explains an attempt that is over, and
      // left in place it would read as the reason this one is outstanding.
      expect(cardRepository.update).toHaveBeenNthCalledWith(
        1,
        {
          id: '1',
          status: CardStatus.NOT_ACTIVATED,
          activationStatus: CardActivationStatus.FAILED,
        },
        {
          activationStatus: CardActivationStatus.PENDING,
          activationReasonCode: null,
          activationReason: null,
        },
      );
    });
  });

  describe('writing the card', () => {
    it('writes the new status only against the status it read', async () => {
      // The row was read, a live call was made, and the sweep that watches an
      // opened card writes the same row — so this has to be a compare-and-set
      // rather than a save, or a status that arrived mid-flight is reverted.
      adapter.activateCard.mockResolvedValueOnce({ status: CardStatus.ACTIVE });

      await useCase.execute(input);

      expect(cardRepository.update).toHaveBeenNthCalledWith(
        1,
        {
          id: '1',
          status: CardStatus.NOT_ACTIVATED,
          activationStatus: IsNull(),
        },
        { status: CardStatus.ACTIVE },
      );
    });

    it('writes nothing further when another writer got there first', async () => {
      adapter.activateCard.mockResolvedValueOnce({ status: CardStatus.ACTIVE });
      cardRepository.update.mockResolvedValueOnce({ affected: 0 });
      cardRepository.findOne.mockResolvedValueOnce({
        id: '1',
        publicId: 'card-1',
        partnerId: 'partner-1',
        providerKey: CardProviderKey.AXYS,
        providerCardId: 'axys-card-1',
        status: CardStatus.NOT_ACTIVATED,
      });
      cardRepository.findOne.mockResolvedValueOnce({
        status: CardStatus.ACTIVE,
      });

      const result = await useCase.execute(input);

      // The request is still recorded — the issuer accepted it, and that is the
      // only evidence a partner ever asked. What it must not do is restate the
      // transition, which whoever won the row has already written: both
      // statuses are the one this request read.
      expect(eventRepository.create).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          fromStatus: CardStatus.NOT_ACTIVATED,
          toStatus: CardStatus.NOT_ACTIVATED,
        }),
      );
      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
      // And the answer reports what the row actually says, not the stale value
      // this request read before the call.
      expect(result).toEqual({
        publicId: 'card-1',
        status: CardStatus.ACTIVE,
        activationStatus: null,
      });
    });
  });

  describe('a write the server rolled back', () => {
    // `card_event` keys on `card`, which the sweeps and issuance also write —
    // so a write here can be the victim of a deadlock it did not cause, and
    // unhandled the server's choice reaches a partner as a 500.
    const deadlock = (): QueryFailedError =>
      new QueryFailedError(
        'INSERT',
        [],
        Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' }),
      );

    it('restarts the event write and answers as though nothing happened', async () => {
      adapter.activateCard.mockResolvedValueOnce({
        status: CardStatus.NOT_ACTIVATED,
      });
      eventRepository.save.mockRejectedValueOnce(deadlock());

      await expect(useCase.execute(input)).resolves.toEqual({
        publicId: 'card-1',
        status: CardStatus.NOT_ACTIVATED,
        activationStatus: CardActivationStatus.PENDING,
      });

      expect(eventRepository.save).toHaveBeenCalledTimes(2);
      // The write restarts, not the attempt — the issuer already accepted it.
      expect(adapter.activateCard).toHaveBeenCalledTimes(1);
    });

    it('restarts the compare-and-set', async () => {
      adapter.activateCard.mockResolvedValueOnce({ status: CardStatus.ACTIVE });
      cardRepository.update
        .mockRejectedValueOnce(deadlock())
        .mockResolvedValueOnce({ affected: 1 });

      await expect(useCase.execute(input)).resolves.toEqual({
        publicId: 'card-1',
        status: CardStatus.ACTIVE,
        activationStatus: null,
      });

      expect(cardRepository.update).toHaveBeenCalledTimes(2);
      expect(adapter.activateCard).toHaveBeenCalledTimes(1);
    });

    it('gives up after the restart budget rather than retrying forever', async () => {
      adapter.activateCard.mockResolvedValueOnce({
        status: CardStatus.NOT_ACTIVATED,
      });
      const rolledBack = deadlock();
      eventRepository.save.mockRejectedValue(rolledBack);

      await expect(useCase.execute(input)).rejects.toBe(rolledBack);
      expect(eventRepository.save).toHaveBeenCalledTimes(5);
    });

    it('raises any other write failure on its first occurrence', async () => {
      // Only the failures the server asks the caller to repeat are repeated.
      adapter.activateCard.mockResolvedValueOnce({
        status: CardStatus.NOT_ACTIVATED,
      });
      const failure = new QueryFailedError(
        'INSERT',
        [],
        Object.assign(new Error('column missing'), {
          code: 'ER_BAD_FIELD_ERROR',
        }),
      );
      eventRepository.save.mockRejectedValue(failure);

      await expect(useCase.execute(input)).rejects.toBe(failure);
      expect(eventRepository.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('mapping an issuer refusal', () => {
    it('answers a refused value as a bad request, naming our field', async () => {
      // The adapter refuses before sending, knowing its issuer's documented
      // requirements. Unmapped this reaches a partner as a server fault for
      // something that is theirs to fix.
      const rejection = new CardProviderIntentRejectedError(
        CardProviderKey.HYPERCARD,
        'activationDocument',
        'this issuer activates a card by identity check',
      );
      adapter.activateCard.mockRejectedValue(rejection);

      const raised = (await useCase
        .execute(input)
        .catch((error: unknown) => error)) as Error;

      expect(raised).toBeInstanceOf(BadRequestException);
      // Handed over as the adapter composed it: the field is already named in
      // our vocabulary, so a partner can act on it as it stands.
      expect(raised.message).toContain('activationDocument');
      expect(raised.cause).toBe(rejection);
    });

    it('answers a state refusal as a conflict', async () => {
      const conflict = new CardProviderConflictError(
        CardProviderKey.AXYS,
        'CARD_ALREADY_ACTIVE',
        'Axys card activation failed (HTTP 409, code=CARD_ALREADY_ACTIVE, requestId=req-1): already active',
      );
      adapter.activateCard.mockRejectedValueOnce(conflict);

      await expect(useCase.execute(input)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('does not republish the issuer wording in the conflict body', async () => {
      // Their message carries their own code and wire text — remote content of
      // unknown shape, which is not ours to hand back. It survives on the cause.
      const conflict = new CardProviderConflictError(
        CardProviderKey.AXYS,
        'CARD_ALREADY_ACTIVE',
        'Axys card activation failed (HTTP 409, code=CARD_ALREADY_ACTIVE, requestId=req-1): already active',
      );
      adapter.activateCard.mockRejectedValueOnce(conflict);

      const raised = (await useCase
        .execute(input)
        .catch((error: unknown) => error)) as Error;

      expect(raised.message).not.toContain('CARD_ALREADY_ACTIVE');
      expect(raised.cause).toBe(conflict);
    });

    it('leaves the card alone when the issuer refused', async () => {
      adapter.activateCard.mockRejectedValueOnce(
        new CardProviderConflictError(
          CardProviderKey.AXYS,
          'CARD_ALREADY_ACTIVE',
          'already active',
        ),
      );

      await expect(useCase.execute(input)).rejects.toThrow();

      expect(cardRepository.update).not.toHaveBeenCalled();
      expect(eventRepository.save).not.toHaveBeenCalled();
      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
    });
  });
});
