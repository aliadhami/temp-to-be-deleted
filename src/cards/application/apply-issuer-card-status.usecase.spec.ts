import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { WebhookDeliveryService } from '../../payments/infrastructure/webhooks/webhook-delivery.service';
import { CardActivationStatus } from '../domain/card-activation-status.enum';
import { CardCapability } from '../domain/card-capability.enum';
import { CardEventSource } from '../domain/card-event-source.enum';
import { CardApplicationOutcome } from '../domain/card-issuer.port';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardApplicationEntity } from '../infrastructure/persistence/card-application.entity';
import { CardEventEntity } from '../infrastructure/persistence/card-event.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { ApplyIssuerCardStatusUseCase } from './apply-issuer-card-status.usecase';

describe('ApplyIssuerCardStatusUseCase', () => {
  let useCase: ApplyIssuerCardStatusUseCase;
  let cardRepository: {
    findOne: jest.Mock;
    update: jest.Mock;
    query: jest.Mock;
  };
  let applicationRepository: { findOne: jest.Mock };
  let eventRepository: { create: jest.Mock; save: jest.Mock };
  let cardIssuerRegistry: { resolve: jest.Mock; keysWithCapability: jest.Mock };
  let webhookDeliveryService: { enqueueForCard: jest.Mock };
  let adapter: { getCardApplicationResult: jest.Mock };
  let warnSpy: jest.SpyInstance;

  const PROVIDER_CARD_ID = '6232931889900031321';
  const REQUEST_ID = '0b03f62e-b9eb-4b72-b482-2288de5b2848';

  const card = (overrides: Partial<CardEntity> = {}): CardEntity =>
    ({
      id: '10',
      publicId: 'card-public-id',
      partnerId: '99',
      status: CardStatus.ACTIVE,
      ...overrides,
    }) as CardEntity;

  /** Their lookup answering that the card exists and is at `status`. */
  const issued = (
    status: CardStatus,
    extra: Partial<Extract<CardApplicationOutcome, { state: 'ISSUED' }>> = {},
  ): CardApplicationOutcome => ({
    state: 'ISSUED',
    providerCardId: PROVIDER_CARD_ID,
    status,
    statusRecognised: true,
    rawPayload: {},
    ...extra,
  });

  /** Stands in for a transaction's manager, so writes assert the same way. */
  const managerFor = (): unknown => ({
    getRepository: (entity: unknown) =>
      entity === CardEventEntity ? eventRepository : cardRepository,
  });

  const apply = (announced: CardStatus) =>
    useCase.execute(CardProviderKey.HYPERCARD, PROVIDER_CARD_ID, announced);

  /** The columns the card `update` call actually set. */
  const writtenColumns = (): Record<string, unknown> => {
    const [, changes] = (cardRepository.update.mock.calls[0] ??
      []) as unknown[];
    return changes as Record<string, unknown>;
  };

  /** The event row this handler saved. */
  const writtenEvent = (): Record<string, unknown> => {
    const [row] = (eventRepository.save.mock.calls[0] ?? [{}]) as unknown[];
    return row as Record<string, unknown>;
  };

  beforeEach(async () => {
    cardRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      // The ordinary outcome; a case wanting the lost race says so.
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      // The rotation stamp is raw SQL through the repository.
      query: jest.fn(),
    };
    applicationRepository = {
      findOne: jest.fn().mockResolvedValue({ id: '1', requestId: REQUEST_ID }),
    };
    eventRepository = {
      create: jest.fn((row: unknown) => row),
      save: jest.fn(),
    };
    adapter = { getCardApplicationResult: jest.fn() };
    cardIssuerRegistry = {
      resolve: jest.fn(() => adapter),
      keysWithCapability: jest
        .fn()
        .mockReturnValue([CardProviderKey.HYPERCARD]),
    };
    webhookDeliveryService = { enqueueForCard: jest.fn() };

    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplyIssuerCardStatusUseCase,
        { provide: getRepositoryToken(CardEntity), useValue: cardRepository },
        {
          provide: getRepositoryToken(CardApplicationEntity),
          useValue: applicationRepository,
        },
        { provide: CardIssuerRegistry, useValue: cardIssuerRegistry },
        { provide: WebhookDeliveryService, useValue: webhookDeliveryService },
        {
          provide: DataSource,
          useValue: {
            transaction: (run: (manager: unknown) => Promise<unknown>) =>
              run(managerFor()),
          },
        },
      ],
    }).compile();

    useCase = module.get(ApplyIssuerCardStatusUseCase);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('asking the issuer', () => {
    it('freezes a card their lookup confirms is frozen', async () => {
      cardRepository.findOne.mockResolvedValue(card());
      adapter.getCardApplicationResult.mockResolvedValue(
        issued(CardStatus.ON_HOLD),
      );

      await expect(apply(CardStatus.ON_HOLD)).resolves.toBe('RESOLVED');

      expect(adapter.getCardApplicationResult).toHaveBeenCalledWith(
        REQUEST_ID,
        {},
      );
      expect(cardRepository.update).toHaveBeenCalledWith(
        { id: '10', status: CardStatus.ACTIVE },
        { status: CardStatus.ON_HOLD },
      );
      expect(writtenEvent()).toMatchObject({
        fromStatus: CardStatus.ACTIVE,
        toStatus: CardStatus.ON_HOLD,
        // Not RECONCILE: no timer re-reads an active card.
        source: CardEventSource.CALLBACK,
        // Their lookup answered, so nothing qualifies the transition.
        detail: null,
      });
      expect(webhookDeliveryService.enqueueForCard).toHaveBeenCalledWith(
        '10',
        '99',
        'card.status_updated',
        expect.objectContaining({ status: CardStatus.ON_HOLD }),
      );
    });

    it('writes what the issuer says, not what the notification claimed', async () => {
      cardRepository.findOne.mockResolvedValue(card());
      adapter.getCardApplicationResult.mockResolvedValue(
        issued(CardStatus.CLOSED),
      );

      await apply(CardStatus.ON_HOLD);

      expect(writtenColumns()).toEqual({ status: CardStatus.CLOSED });
    });

    it('releases a card their lookup confirms is released', async () => {
      cardRepository.findOne.mockResolvedValue(
        card({ status: CardStatus.ON_HOLD }),
      );
      adapter.getCardApplicationResult.mockResolvedValue(
        issued(CardStatus.ACTIVE),
      );

      await apply(CardStatus.ACTIVE);

      expect(writtenColumns()).toMatchObject({ status: CardStatus.ACTIVE });
    });

    it('looks the card up on the issuer as well as on its card id', async () => {
      cardRepository.findOne.mockResolvedValue(card());
      adapter.getCardApplicationResult.mockResolvedValue(
        issued(CardStatus.ON_HOLD),
      );

      await apply(CardStatus.ON_HOLD);

      expect(cardRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            providerKey: CardProviderKey.HYPERCARD,
            providerCardId: PROVIDER_CARD_ID,
          },
        }),
      );
    });
  });

  describe('when their lookup gives no usable answer', () => {
    /** Every case below must still move the card, and say why on the event. */
    const expectFellBack = (): void => {
      expect(writtenColumns()).toEqual({ status: CardStatus.ON_HOLD });
      expect(writtenEvent().detail).toContain('notification');
    };

    beforeEach(() => {
      cardRepository.findOne.mockResolvedValue(card());
    });

    it('takes the notification when the call fails', async () => {
      adapter.getCardApplicationResult.mockRejectedValue(
        new Error('the issuer is unreachable'),
      );

      await expect(apply(CardStatus.ON_HOLD)).resolves.toBe('RESOLVED');

      expectFellBack();
      expect(warnSpy).toHaveBeenCalled();
    });

    it('takes the notification when they report no card', async () => {
      adapter.getCardApplicationResult.mockResolvedValue({
        state: 'PENDING',
        rawPayload: {},
      });

      await apply(CardStatus.ON_HOLD);

      expectFellBack();
      expect(warnSpy).toHaveBeenCalled();
    });

    it('takes the notification when they answer about a different card', async () => {
      adapter.getCardApplicationResult.mockResolvedValue(
        issued(CardStatus.ACTIVE, { providerCardId: 'a-different-card' }),
      );

      await apply(CardStatus.ON_HOLD);

      expectFellBack();
      expect(warnSpy).toHaveBeenCalled();
    });

    it('takes the notification when the card has no application row', async () => {
      applicationRepository.findOne.mockResolvedValue(null);

      await apply(CardStatus.ON_HOLD);

      expect(adapter.getCardApplicationResult).not.toHaveBeenCalled();
      expectFellBack();
      expect(warnSpy).toHaveBeenCalled();
    });

    it('takes the notification when their code is one nothing can read', async () => {
      adapter.getCardApplicationResult.mockResolvedValue(
        issued(CardStatus.NOT_ACTIVATED, { statusRecognised: false }),
      );

      await apply(CardStatus.ON_HOLD);

      expectFellBack();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('cannot read') as string,
      );
    });

    it('takes the notification when the provider reports no outcomes', async () => {
      cardIssuerRegistry.keysWithCapability.mockReturnValue([]);

      await apply(CardStatus.ON_HOLD);

      expect(applicationRepository.findOne).not.toHaveBeenCalled();
      expect(adapter.getCardApplicationResult).not.toHaveBeenCalled();
      expectFellBack();
      // It falls back on every delivery, so a line per push is noise.
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('stamps the rotation whatever the answer, so the row does not jump', async () => {
      adapter.getCardApplicationResult.mockRejectedValue(new Error('down'));

      await apply(CardStatus.ON_HOLD);

      expect(cardRepository.query).toHaveBeenCalledWith(
        expect.stringContaining('`status_checked_at`') as string,
        expect.arrayContaining(['10']) as unknown[],
      );
    });

    it('asks for the outcome the batch pass is filtered by', async () => {
      adapter.getCardApplicationResult.mockResolvedValue(
        issued(CardStatus.ON_HOLD),
      );

      await apply(CardStatus.ON_HOLD);

      expect(cardIssuerRegistry.keysWithCapability).toHaveBeenCalledWith(
        CardCapability.APPLICATION_RESULT,
      );
    });
  });

  describe('what it refuses to write', () => {
    it('writes nothing at all when the card is already where they say it is', async () => {
      // A redelivery announces a change already made, and an event describes a
      // transition rather than a state.
      cardRepository.findOne.mockResolvedValue(
        card({ status: CardStatus.ON_HOLD }),
      );
      adapter.getCardApplicationResult.mockResolvedValue(
        issued(CardStatus.ON_HOLD),
      );

      await expect(apply(CardStatus.ON_HOLD)).resolves.toBe('RESOLVED');

      expect(cardRepository.update).not.toHaveBeenCalled();
      expect(eventRepository.save).not.toHaveBeenCalled();
      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
    });

    it('never takes a closed card back out of being closed', async () => {
      // The compare-and-set cannot express this: it keys on the status read, so
      // a closed card matches itself and the write would go through.
      cardRepository.findOne.mockResolvedValue(
        card({ status: CardStatus.CLOSED }),
      );
      adapter.getCardApplicationResult.mockResolvedValue(
        issued(CardStatus.ACTIVE),
      );

      await expect(apply(CardStatus.ACTIVE)).resolves.toBe('RESOLVED');

      expect(cardRepository.update).not.toHaveBeenCalled();
      expect(eventRepository.save).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('card-public-id') as string,
      );
    });

    it('says a card this database does not hold is not here', async () => {
      // An issuer account carries one callback address, so whichever
      // environment holds it receives every environment's events.
      await expect(apply(CardStatus.ON_HOLD)).resolves.toBe('NO_ROW');

      expect(adapter.getCardApplicationResult).not.toHaveBeenCalled();
      expect(cardRepository.update).not.toHaveBeenCalled();
    });

    it('announces nothing when something else moved the card first', async () => {
      cardRepository.findOne.mockResolvedValue(card());
      adapter.getCardApplicationResult.mockResolvedValue(
        issued(CardStatus.ON_HOLD),
      );
      cardRepository.update.mockResolvedValue({ affected: 0 });

      await expect(apply(CardStatus.ON_HOLD)).resolves.toBe('RESOLVED');

      expect(eventRepository.save).not.toHaveBeenCalled();
      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('the activation columns', () => {
    beforeEach(() => {
      cardRepository.findOne.mockResolvedValue(
        card({
          status: CardStatus.NOT_ACTIVATED,
          activationStatus: CardActivationStatus.PENDING,
        }),
      );
    });

    it('clears them once the issuer reports the card usable', async () => {
      adapter.getCardApplicationResult.mockResolvedValue(
        issued(CardStatus.ACTIVE),
      );

      await apply(CardStatus.ACTIVE);

      expect(writtenColumns()).toEqual({
        status: CardStatus.ACTIVE,
        activationStatus: null,
        activationReasonCode: null,
        activationReason: null,
      });
    });

    it('leaves them alone on any other move, reasons included', async () => {
      adapter.getCardApplicationResult.mockResolvedValue(
        issued(CardStatus.ON_HOLD, {
          activation: CardActivationStatus.FAILED,
          reasonCode: 'E001',
          reason: 'the photograph is blurred',
        }),
      );

      await apply(CardStatus.ON_HOLD);

      expect(writtenColumns()).toEqual({ status: CardStatus.ON_HOLD });
    });

    it('leaves them alone when the notification is all there is', async () => {
      adapter.getCardApplicationResult.mockRejectedValue(new Error('down'));

      await apply(CardStatus.ON_HOLD);

      expect(writtenColumns()).toEqual({ status: CardStatus.ON_HOLD });
    });
  });

  it('keeps the transition when the partner cannot be notified', async () => {
    cardRepository.findOne.mockResolvedValue(card());
    adapter.getCardApplicationResult.mockResolvedValue(
      issued(CardStatus.ON_HOLD),
    );
    webhookDeliveryService.enqueueForCard.mockRejectedValue(
      new Error('the queue is down'),
    );

    // The card row has moved, so a retry would find no transition to announce.
    await expect(apply(CardStatus.ON_HOLD)).resolves.toBe('RESOLVED');

    expect(eventRepository.save).toHaveBeenCalledTimes(1);
  });
});
