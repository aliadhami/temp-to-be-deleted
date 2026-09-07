import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Not } from 'typeorm';
import { WebhookDeliveryService } from '../../payments/infrastructure/webhooks/webhook-delivery.service';
import { CardApplicationStatus } from '../domain/card-application-status.enum';
import { CardCapability } from '../domain/card-capability.enum';
import { CardEventSource } from '../domain/card-event-source.enum';
import {
  CardApplicationOutcome,
  CardIssuerPort,
} from '../domain/card-issuer.port';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardActivationStatus } from '../domain/card-activation-status.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardApplicationEntity } from '../infrastructure/persistence/card-application.entity';
import { CardEventEntity } from '../infrastructure/persistence/card-event.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { ReconcileNotActivatedCardsUseCase } from './reconcile-not-activated-cards.usecase';

describe('ReconcileNotActivatedCardsUseCase', () => {
  let useCase: ReconcileNotActivatedCardsUseCase;
  let cardRepository: {
    find: jest.Mock;
    findAndCount: jest.Mock;
    update: jest.Mock;
    query: jest.Mock;
  };
  let applicationRepository: { find: jest.Mock; update: jest.Mock };
  let eventRepository: { create: jest.Mock; save: jest.Mock };
  let cardIssuerRegistry: { resolve: jest.Mock; keysWithCapability: jest.Mock };
  let webhookDeliveryService: { enqueueForCard: jest.Mock };
  let warnSpy: jest.SpyInstance;

  const BATCH_SIZE = 50;
  const PROVIDER_CARD_ID = '30803710524000026680';

  /**
   * The stamp is `new Date()` inside the pass, so only its type can be
   * asserted. Named and typed here because `expect.any` is `any`, which the
   * lint rules refuse inside an object literal.
   */
  const ANY_DATE = expect.any(Date) as unknown as Date;

  const card = (overrides: Partial<CardEntity> = {}): CardEntity =>
    ({
      id: '10',
      publicId: 'card-public-id',
      partnerId: '99',
      providerKey: CardProviderKey.HYPERCARD,
      providerCardId: PROVIDER_CARD_ID,
      status: CardStatus.NOT_ACTIVATED,
      maskedPan: null,
      activationStatus: null,
      activationReasonCode: null,
      activationReason: null,
      ...overrides,
    }) as CardEntity;

  const application = (
    overrides: Partial<CardApplicationEntity> = {},
  ): CardApplicationEntity =>
    ({
      id: '1',
      cardId: '10',
      requestId: '58ab0f9ce43340be9e38191cc20f0437',
      status: CardApplicationStatus.APPROVED,
      reasonCode: null,
      message: null,
      ...overrides,
    }) as CardApplicationEntity;

  /** Their result lookup still naming this card, at whatever status. */
  const issued = (
    overrides: Partial<
      Extract<CardApplicationOutcome, { state: 'ISSUED' }>
    > = {},
  ): CardApplicationOutcome =>
    ({
      state: 'ISSUED',
      statusRecognised: true,
      providerCardId: PROVIDER_CARD_ID,
      status: CardStatus.NOT_ACTIVATED,
      rawPayload: { card_id: PROVIDER_CARD_ID },
      ...overrides,
    }) satisfies CardApplicationOutcome;

  // Typed against the port so the double cannot drift from the interface it
  // stands in for.
  type IssuerDouble = Pick<CardIssuerPort, 'capabilities'> & {
    getCardApplicationResult: jest.Mock;
  };

  const issuerDouble = (outcome?: CardApplicationOutcome): IssuerDouble => ({
    capabilities: new Set([CardCapability.APPLICATION_RESULT]),
    getCardApplicationResult: jest.fn().mockResolvedValue(outcome),
  });

  /** Stands in for a transaction's manager, so writes assert the same way. */
  const managerFor = (): unknown => ({
    getRepository: (entity: unknown) => {
      if (entity === CardEntity) return cardRepository;
      if (entity === CardEventEntity) return eventRepository;
      return applicationRepository;
    },
  });

  /** The ordinary arrangement: one waiting card with its application row. */
  const seed = (
    outcome: CardApplicationOutcome,
    cardOverrides: Partial<CardEntity> = {},
    applicationOverrides: Partial<CardApplicationEntity> = {},
  ): IssuerDouble => {
    cardRepository.findAndCount.mockResolvedValue([[card(cardOverrides)], 1]);
    applicationRepository.find.mockResolvedValue([
      application(applicationOverrides),
    ]);
    const adapter = issuerDouble(outcome);
    cardIssuerRegistry.resolve.mockReturnValue(adapter);
    return adapter;
  };

  beforeEach(async () => {
    cardRepository = {
      // The outstanding-activation half of the selection. Empty by default, so
      // a case that seeds `findAndCount` alone still describes the rotation.
      find: jest.fn().mockResolvedValue([]),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      // One row matched, which is the ordinary outcome of the conditional
      // write. A case that wants the lost race says so explicitly.
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      query: jest.fn(),
    };
    applicationRepository = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    };
    eventRepository = {
      create: jest.fn().mockImplementation((row: unknown) => row),
      save: jest.fn(),
    };
    cardIssuerRegistry = {
      resolve: jest.fn(),
      keysWithCapability: jest
        .fn()
        .mockReturnValue([CardProviderKey.HYPERCARD]),
    };
    webhookDeliveryService = { enqueueForCard: jest.fn() };

    // Every per-card failure is swallowed into logger.warn, so without this spy
    // a crash inside the loop is indistinguishable from a clean skip and the
    // negative assertions below would pass vacuously.
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReconcileNotActivatedCardsUseCase,
        { provide: getRepositoryToken(CardEntity), useValue: cardRepository },
        {
          provide: getRepositoryToken(CardApplicationEntity),
          useValue: applicationRepository,
        },
        { provide: CardIssuerRegistry, useValue: cardIssuerRegistry },
        {
          provide: WebhookDeliveryService,
          useValue: webhookDeliveryService,
        },
        {
          provide: ConfigService,
          useValue: { getOrThrow: jest.fn().mockReturnValue(BATCH_SIZE) },
        },
        {
          provide: DataSource,
          useValue: {
            transaction: (run: (manager: unknown) => Promise<unknown>) =>
              run(managerFor()),
          },
        },
      ],
    }).compile();

    useCase = module.get(ReconcileNotActivatedCardsUseCase);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('selection', () => {
    /** The whole query, asserted exactly rather than in parts. */
    it('asks for the least-recently-checked cards an issuer has opened and not yet made usable', async () => {
      await useCase.execute();

      expect(cardRepository.findAndCount).toHaveBeenCalledWith({
        where: {
          status: CardStatus.NOT_ACTIVATED,
          providerKey: In([CardProviderKey.HYPERCARD]),
          providerCardId: Not(IsNull()),
        },
        select: {
          id: true,
          publicId: true,
          partnerId: true,
          providerKey: true,
          providerCardId: true,
          status: true,
          maskedPan: true,
          activationStatus: true,
          activationReasonCode: true,
          activationReason: true,
        },
        order: { statusCheckedAt: 'ASC', id: 'ASC' },
        take: BATCH_SIZE,
      });
    });

    it('asks for cards with an activation outstanding by the same rules, separately', async () => {
      await useCase.execute();

      // Ordered the same way, so two outstanding cards still rotate between
      // themselves.
      expect(cardRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: CardStatus.NOT_ACTIVATED,
            providerKey: In([CardProviderKey.HYPERCARD]),
            providerCardId: Not(IsNull()),
            activationStatus: CardActivationStatus.PENDING,
          },
          order: { statusCheckedAt: 'ASC', id: 'ASC' },
          take: BATCH_SIZE,
        }),
      );
    });

    it('examines a card with an outstanding activation ahead of the rotation', async () => {
      // Without this, a just-activated card queues behind every card nobody is
      // waiting on — and that set never drains.
      const waiting = card({
        id: '99',
        publicId: 'waiting',
        activationStatus: CardActivationStatus.PENDING,
      });
      cardRepository.find.mockResolvedValue([waiting]);
      cardRepository.findAndCount.mockResolvedValue([[card({ id: '10' })], 2]);
      applicationRepository.find.mockResolvedValue([
        application({ cardId: '99' }),
        application({ id: '2', cardId: '10' }),
      ]);
      const adapter = issuerDouble(issued());
      cardIssuerRegistry.resolve.mockReturnValue(adapter);

      await useCase.execute();

      const stamped = (
        cardRepository.query.mock.calls[0] as [string, unknown[]]
      )[1].slice(1);
      expect(stamped[0]).toBe('99');
    });

    it('does not examine one card twice when the rotation names it too', async () => {
      // Both queries read the same table. Asking twice would append two events
      // for one transition.
      const waiting = card({
        id: '99',
        activationStatus: CardActivationStatus.PENDING,
      });
      cardRepository.find.mockResolvedValue([waiting]);
      cardRepository.findAndCount.mockResolvedValue([[waiting], 1]);
      applicationRepository.find.mockResolvedValue([
        application({ cardId: '99' }),
      ]);
      const adapter = issuerDouble(issued());
      cardIssuerRegistry.resolve.mockReturnValue(adapter);

      await useCase.execute();

      expect(adapter.getCardApplicationResult).toHaveBeenCalledTimes(1);
    });

    it('spends no batch slot on the rotation when outstanding cards fill it', async () => {
      const outstanding = Array.from({ length: BATCH_SIZE }, (_, index) =>
        card({
          id: String(1000 + index),
          activationStatus: CardActivationStatus.PENDING,
        }),
      );
      cardRepository.find.mockResolvedValue(outstanding);
      cardRepository.findAndCount.mockResolvedValue([
        [card({ id: '10' })],
        BATCH_SIZE + 1,
      ]);
      applicationRepository.find.mockResolvedValue([]);

      await useCase.execute();

      const stamped = (
        cardRepository.query.mock.calls[0] as [string, unknown[]]
      )[1].slice(1);
      expect(stamped).toHaveLength(BATCH_SIZE);
      expect(stamped).not.toContain('10');
    });

    it('excludes providers that answer no outcome separately, in the query', async () => {
      // Skipping such a card after loading it would still spend the batch on
      // it, and those rows accumulate — so the filter has to be in the query.
      cardIssuerRegistry.keysWithCapability.mockReturnValue([]);

      await useCase.execute();

      expect(cardIssuerRegistry.keysWithCapability).toHaveBeenCalledWith(
        CardCapability.APPLICATION_RESULT,
      );
      expect(cardRepository.findAndCount).not.toHaveBeenCalled();
    });
  });

  describe('recording that the pass looked', () => {
    it('stamps every card it selected, before examining any of them', async () => {
      seed(issued());

      await useCase.execute();

      expect(cardRepository.query).toHaveBeenCalledWith(
        expect.stringContaining('SET `status_checked_at` = ?'),
        [ANY_DATE, '10'],
      );
    });

    it('pins updated_at so the stamp is not mistaken for a change', async () => {
      // Two mechanisms would move it and the statement has to defeat both:
      // TypeORM adds `@UpdateDateColumn` to every SET clause, which is why the
      // stamp is raw SQL, and the column is additionally `ON UPDATE
      // CURRENT_TIMESTAMP(6)` in the migration, which fires whatever the SET
      // list names.
      seed(issued());

      await useCase.execute();

      expect(cardRepository.query).toHaveBeenCalledWith(
        expect.stringContaining('`updated_at` = `updated_at`'),
        [ANY_DATE, '10'],
      );
    });

    it('stamps a card whose lookup failed as well', async () => {
      // Otherwise one card the issuer cannot answer for holds the head of the
      // queue for ever and starves everything behind it — which is the exact
      // failure the ordering above exists to prevent.
      const adapter = seed(issued());
      adapter.getCardApplicationResult.mockRejectedValue(
        new Error('issuer is away'),
      );

      await useCase.execute();

      expect(cardRepository.query).toHaveBeenCalledWith(
        expect.stringContaining('SET `status_checked_at` = ?'),
        [ANY_DATE, '10'],
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Could not read the status'),
      );
    });

    it('asks by the reference the application was sent with', async () => {
      const adapter = seed(issued());

      await useCase.execute();

      expect(adapter.getCardApplicationResult).toHaveBeenCalledWith(
        '58ab0f9ce43340be9e38191cc20f0437',
        {},
      );
    });
  });

  describe('a card that has not moved', () => {
    it('writes nothing but the stamp', async () => {
      // Their activating code maps to the same not-activated status, and it is
      // a transient state rather than one to report as stuck.
      seed(issued({ status: CardStatus.NOT_ACTIVATED }));

      await useCase.execute();

      // The stamp is a raw statement, so the row itself is never updated.
      expect(cardRepository.update).not.toHaveBeenCalled();
      expect(eventRepository.save).not.toHaveBeenCalled();
      expect(applicationRepository.update).not.toHaveBeenCalled();
      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
    });
  });

  describe('the activation an issuer is still settling', () => {
    it('stamps a pending activation this pass found and the row does not carry', async () => {
      // The repair path: a request that reached the issuer and died before its
      // own write leaves nothing on the row, and this is where it is recovered.
      seed(issued({ activation: CardActivationStatus.PENDING }));

      await useCase.execute();

      expect(cardRepository.update).toHaveBeenCalledWith(
        { id: '10', status: CardStatus.NOT_ACTIVATED },
        {
          activationStatus: CardActivationStatus.PENDING,
          activationReasonCode: null,
          activationReason: null,
        },
      );
    });

    it('writes nothing when the row already says the same', async () => {
      seed(issued({ activation: CardActivationStatus.PENDING }), {
        activationStatus: CardActivationStatus.PENDING,
      });

      await useCase.execute();

      expect(cardRepository.update).not.toHaveBeenCalled();
    });

    it('records a refusal with the issuer’s own code and words', async () => {
      seed(
        issued({
          activation: CardActivationStatus.FAILED,
          reasonCode: 'E0005',
          reason:
            'Please hold both the bank card and passport in the activation photo',
        }),
        { activationStatus: CardActivationStatus.PENDING },
      );

      await useCase.execute();

      expect(cardRepository.update).toHaveBeenCalledWith(
        { id: '10', status: CardStatus.NOT_ACTIVATED },
        {
          activationStatus: CardActivationStatus.FAILED,
          activationReasonCode: 'E0005',
          activationReason:
            'Please hold both the bank card and passport in the activation photo',
        },
      );
    });

    it('leaves a pending stamp alone when the issuer says nothing about one', async () => {
      // **The trap.** They go on reporting a card at its pre-activation code
      // for a while after accepting an activation, so an answer with no
      // activation stage has to change nothing — clearing here would clear the
      // stamp during exactly the window it exists for.
      seed(issued({ status: CardStatus.NOT_ACTIVATED }), {
        activationStatus: CardActivationStatus.PENDING,
      });

      await useCase.execute();

      expect(cardRepository.update).not.toHaveBeenCalled();
    });

    it('clears the stamp when the card reaches usable', async () => {
      seed(issued({ status: CardStatus.ACTIVE }), {
        activationStatus: CardActivationStatus.PENDING,
        activationReasonCode: 'E0000',
        activationReason:
          'Bank card information in the activation photo is unclear',
      });

      await useCase.execute();

      expect(cardRepository.update).toHaveBeenCalledWith(
        { id: '10', status: CardStatus.NOT_ACTIVATED },
        {
          status: CardStatus.ACTIVE,
          activationStatus: null,
          activationReasonCode: null,
          activationReason: null,
        },
      );
    });
  });

  describe('a card that becomes usable', () => {
    it('writes the status, an event and the partner webhook', async () => {
      seed(issued({ status: CardStatus.ACTIVE }));

      await useCase.execute();

      expect(cardRepository.update).toHaveBeenCalledWith(
        { id: '10', status: CardStatus.NOT_ACTIVATED },
        expect.objectContaining({ status: CardStatus.ACTIVE }),
      );
      expect(eventRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          cardId: '10',
          fromStatus: CardStatus.NOT_ACTIVATED,
          toStatus: CardStatus.ACTIVE,
          source: CardEventSource.RECONCILE,
        }),
      );
      expect(webhookDeliveryService.enqueueForCard).toHaveBeenCalledWith(
        '10',
        '99',
        'card.activated',
        expect.objectContaining({
          eventType: 'card.activated',
          cardPublicId: 'card-public-id',
          status: CardStatus.ACTIVE,
        }),
      );
    });

    it('does not announce it twice', async () => {
      // The second pass finds the card already active, so it is no longer in
      // the selection at all — but a card that somehow is must not re-announce.
      seed(issued({ status: CardStatus.ACTIVE }), {
        status: CardStatus.ACTIVE,
      });

      await useCase.execute();

      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
      expect(eventRepository.save).not.toHaveBeenCalled();
    });

    it('records another terminal status without announcing an activation', async () => {
      seed(issued({ status: CardStatus.CLOSED }));

      await useCase.execute();

      expect(cardRepository.update).toHaveBeenCalledWith(
        { id: '10', status: CardStatus.NOT_ACTIVATED },
        expect.objectContaining({ status: CardStatus.CLOSED }),
      );
      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
    });
  });

  describe('the masked number', () => {
    it('fills one in when it arrives late', async () => {
      // The result lookup resolves on the card id and does not come back for a
      // number that lands after it, because the row has left its selection by
      // then. This pass is where that gap closes.
      seed(issued({ maskedPan: '624673******6680' }));

      await useCase.execute();

      expect(cardRepository.update).toHaveBeenCalledWith(
        { id: '10', status: CardStatus.NOT_ACTIVATED },
        expect.objectContaining({ maskedPan: '624673******6680' }),
      );
    });

    it('never blanks one already stored', async () => {
      // An issuer that sends its identifiers separately reports an absent
      // number as "not sent this time", never as "this card has none".
      seed(issued(), { maskedPan: '624673******6680' });

      await useCase.execute();

      expect(cardRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('a fault the issuer reports', () => {
    it('persists their code and prose against the application', async () => {
      seed(
        issued({
          reasonCode: 'E0003',
          reason:
            'Incorrect activation photo; finger is not covering the chip slot',
        }),
      );

      await useCase.execute();

      expect(applicationRepository.update).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({
          reasonCode: 'E0003',
          message:
            'Incorrect activation photo; finger is not covering the chip slot',
          responsePayload: { card_id: PROVIDER_CARD_ID },
        }),
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('E0003'));
    });

    it('says nothing on a later pass while the fault is unchanged', async () => {
      // This pass only observes — there is nothing here to retry, so an
      // unchanged fault is not news.
      seed(
        issued({ reasonCode: 'E0003', reason: 'Incorrect activation photo' }),
        {},
        { reasonCode: 'E0003', message: 'Incorrect activation photo' },
      );

      await useCase.execute();

      expect(applicationRepository.update).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('clears a fault the issuer has stopped reporting', async () => {
      // Written as an explicit null rather than left undefined, which TypeORM
      // would skip — leaving a cleared reason on the row for ever.
      seed(issued(), {}, { reasonCode: 'E0003', message: 'Was unclear' });

      await useCase.execute();

      expect(applicationRepository.update).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({ reasonCode: null, message: null }),
      );
    });

    it('compares against the truncated form it stores', async () => {
      // Comparing an issuer's full text against a previously-truncated copy of
      // itself never matches, so an over-length reason would look changed on
      // every pass for ever — rewriting the row and re-warning each time.
      const long = 'x'.repeat(400);
      seed(
        issued({ reasonCode: 'E0003', reason: long }),
        {},
        { reasonCode: 'E0003', message: long.slice(0, 255) },
      );

      await useCase.execute();

      expect(applicationRepository.update).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('clears a stale fault when the issuer reports the card usable', async () => {
      // Their fail fields describe an attempt rather than a moment, and a re-
      // activated card is amended in place under the same reference — so a
      // code from a superseded attempt can sit on a payload whose status is
      // their activated one.
      seed(
        issued({ status: CardStatus.ACTIVE, reasonCode: 'E0003' }),
        {},
        { reasonCode: 'E0003', message: 'Incorrect activation photo' },
      );

      await useCase.execute();

      expect(applicationRepository.update).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({ reasonCode: null, message: null }),
      );
      expect(warnSpy).not.toHaveBeenCalled();
      expect(webhookDeliveryService.enqueueForCard).toHaveBeenCalled();
    });

    it('carries it onto the event when the status moves too', async () => {
      seed(
        issued({
          status: CardStatus.CLOSED,
          reasonCode: 'D0006',
          reason: 'Incorrect name',
        }),
      );

      await useCase.execute();

      expect(eventRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ detail: 'D0006: Incorrect name' }),
      );
    });
  });

  describe('a card something else moved first', () => {
    it('writes nothing when the conditional update matches no row', async () => {
      // The activation route is the concrete racer: it writes the card and
      // enqueues the partner's event itself, so an unconditional write here
      // would overwrite its result, append a second event for a transition
      // already recorded, and announce the same activation twice.
      cardRepository.update.mockResolvedValue({ affected: 0 });
      seed(issued({ status: CardStatus.ACTIVE }));

      await useCase.execute();

      expect(eventRepository.save).not.toHaveBeenCalled();
      expect(applicationRepository.update).not.toHaveBeenCalled();
      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('moved out of'),
      );
    });

    it('writes conditionally on the status it actually read', async () => {
      seed(issued({ status: CardStatus.ACTIVE }));

      await useCase.execute();

      expect(cardRepository.update).toHaveBeenCalledWith(
        { id: '10', status: CardStatus.NOT_ACTIVATED },
        expect.anything(),
      );
    });
  });

  describe('answers this pass will not act on', () => {
    it('leaves a card the issuer no longer names alone', async () => {
      seed({ state: 'UNKNOWN_REFERENCE' });

      await useCase.execute();

      expect(cardRepository.update).not.toHaveBeenCalled();
      expect(eventRepository.save).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('no longer reports a card'),
      );
    });

    it('leaves a card whose id disagrees with theirs alone', async () => {
      // Writing a status read off some other card is worse than writing
      // nothing, and it is not a disagreement this pass can settle.
      seed(issued({ providerCardId: 'a-different-card' }));

      await useCase.execute();

      expect(cardRepository.update).not.toHaveBeenCalled();
      expect(eventRepository.save).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('leaving both alone'),
      );
    });

    it('skips a card with no application row to ask by', async () => {
      cardRepository.findAndCount.mockResolvedValue([[card()], 1]);
      applicationRepository.find.mockResolvedValue([]);

      await useCase.execute();

      expect(cardIssuerRegistry.resolve).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('no application row'),
      );
    });
  });

  describe('per-card isolation', () => {
    it("one card's failure does not abort the pass for the rest", async () => {
      cardRepository.findAndCount.mockResolvedValue([
        [
          card({ id: '10', publicId: 'first' }),
          card({ id: '11', publicId: 'second' }),
        ],
        2,
      ]);
      applicationRepository.find.mockResolvedValue([
        application({ id: '1', cardId: '10' }),
        application({ id: '2', cardId: '11' }),
      ]);

      const adapter = issuerDouble();
      adapter.getCardApplicationResult
        .mockRejectedValueOnce(new Error('issuer is away'))
        .mockResolvedValueOnce(issued({ status: CardStatus.ACTIVE }));
      cardIssuerRegistry.resolve.mockReturnValue(adapter);

      await expect(useCase.execute()).resolves.toBeUndefined();

      expect(webhookDeliveryService.enqueueForCard).toHaveBeenCalledWith(
        '11',
        '99',
        'card.activated',
        expect.anything(),
      );
    });
  });
});
