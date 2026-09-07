import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookDeliveryService } from '../../payments/infrastructure/webhooks/webhook-delivery.service';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CardApplicationStatus } from '../domain/card-application-status.enum';
import { CardCapability } from '../domain/card-capability.enum';
import { CardEventSource } from '../domain/card-event-source.enum';
import {
  CardApplicationOutcome,
  CardIssuerPort,
} from '../domain/card-issuer.port';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardApplicationEntity } from '../infrastructure/persistence/card-application.entity';
import { CardEventEntity } from '../infrastructure/persistence/card-event.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { ResolveCardApplicationsUseCase } from './resolve-card-applications.usecase';

describe('ResolveCardApplicationsUseCase', () => {
  let useCase: ResolveCardApplicationsUseCase;
  let applicationRepository: {
    find: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    query: jest.Mock;
    manager: unknown;
  };
  let cardRepository: { findOne: jest.Mock; save: jest.Mock };
  let eventRepository: { create: jest.Mock; save: jest.Mock };
  let cardIssuerRegistry: { resolve: jest.Mock; keysWithCapability: jest.Mock };
  let webhookDeliveryService: { enqueueForCard: jest.Mock };
  let warnSpy: jest.SpyInstance;

  const BATCH_SIZE = 50;

  const application = (
    overrides: Partial<CardApplicationEntity> = {},
  ): CardApplicationEntity =>
    ({
      id: '1',
      cardId: '10',
      providerKey: CardProviderKey.HYPERCARD,
      requestId: '7e679210e88f4d6abbe21a2b39b0ceed',
      status: CardApplicationStatus.SUBMITTED,
      reasonCode: null,
      message: null,
      responsePayload: null,
      ...overrides,
    }) as CardApplicationEntity;

  const card = (overrides: Partial<CardEntity> = {}): CardEntity =>
    ({
      id: '10',
      publicId: 'card-public-id',
      partnerId: '99',
      providerKey: CardProviderKey.HYPERCARD,
      providerCardId: null,
      maskedPan: null,
      status: CardStatus.NOT_ACTIVATED,
      ...overrides,
    }) as CardEntity;

  // Typed against the port so the double cannot drift from the interface it
  // stands in for — this story adds the method it doubles.
  type IssuerDouble = Pick<CardIssuerPort, 'capabilities'> & {
    getCardApplicationResult: jest.Mock;
  };

  const issuerDouble = (
    outcome?: CardApplicationOutcome,
    capabilities: CardCapability[] = [CardCapability.APPLICATION_RESULT],
  ): IssuerDouble => ({
    capabilities: new Set(capabilities),
    getCardApplicationResult: jest.fn().mockResolvedValue(outcome),
  });

  /**
   * Stands in for both the plain manager and a transaction's, so the writes
   * are asserted the same way whichever they went through.
   * `dataSource.transaction` below hands the callback this object.
   */
  const managerFor = (): unknown => ({
    getRepository: (entity: unknown) => {
      if (entity === CardEntity) return cardRepository;
      if (entity === CardEventEntity) return eventRepository;
      return applicationRepository;
    },
  });

  beforeEach(async () => {
    applicationRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      query: jest.fn(),
      manager: undefined,
    };
    applicationRepository.manager = managerFor();
    cardRepository = { findOne: jest.fn(), save: jest.fn() };
    eventRepository = {
      create: jest.fn().mockImplementation((row: unknown) => row),
      save: jest.fn(),
    };
    cardIssuerRegistry = {
      resolve: jest.fn(),
      // Every case but the exclusion one runs with the asynchronous issuer
      // enabled; the query filter is what the exclusion case asserts.
      keysWithCapability: jest
        .fn()
        .mockReturnValue([CardProviderKey.HYPERCARD]),
    };
    webhookDeliveryService = { enqueueForCard: jest.fn() };

    // Every per-application failure is swallowed into logger.warn, so without
    // this spy a crash inside the loop is indistinguishable from a clean skip
    // and the negative assertions below would pass vacuously.
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResolveCardApplicationsUseCase,
        {
          provide: getRepositoryToken(CardApplicationEntity),
          useValue: applicationRepository,
        },
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

    useCase = module.get(ResolveCardApplicationsUseCase);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('selection', () => {
    it('asks only for applications awaiting an outcome, bounded by the configured batch', async () => {
      // The three states it excludes each have their own reason, and the one
      // that matters most is REJECTED: re-fetching a refusal would overwrite a
      // recorded outcome with a lookup for an application never opened.
      await useCase.execute();

      expect(applicationRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: CardApplicationStatus.SUBMITTED,
          }) as unknown,
          take: BATCH_SIZE,
        }),
      );
    });

    /** The exclusion is in the query, and it has to be. */
    it('excludes providers with no separate outcome from the query itself', async () => {
      cardIssuerRegistry.keysWithCapability.mockReturnValue([
        CardProviderKey.HYPERCARD,
      ]);

      await useCase.execute();

      expect(cardIssuerRegistry.keysWithCapability).toHaveBeenCalledWith(
        CardCapability.APPLICATION_RESULT,
      );
      const [options] = applicationRepository.find.mock.calls[0] as [
        { where: { providerKey: unknown } },
      ];
      // `In([HYPERCARD])` — the value is TypeORM's operator object, so the
      // assertion is that the column is constrained at all and by what.
      expect(JSON.stringify(options.where.providerKey)).toContain('HYPERCARD');
      expect(JSON.stringify(options.where.providerKey)).not.toContain('AXYS');
    });

    it('rotates on when the issuer was last asked, not on the row id', async () => {
      // A pending answer writes nothing, so ordering by id alone lets an
      // application the issuer never resolves hold the head for ever.
      await useCase.execute();

      expect(applicationRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          order: { statusCheckedAt: 'ASC', id: 'ASC' },
        }),
      );
    });

    it('stamps every application it selected, before examining any of them', async () => {
      applicationRepository.find.mockResolvedValue([
        application({ id: '7' }),
        application({ id: '9' }),
      ]);

      await useCase.execute();

      // One statement naming both rows: a row the issuer failed to answer for
      // has still had its turn.
      expect(applicationRepository.query).toHaveBeenCalledTimes(1);
      const [sql, parameters] = applicationRepository.query.mock.calls[0] as [
        string,
        unknown[],
      ];
      expect(sql).toContain('`status_checked_at`');
      expect(parameters.slice(1)).toEqual(['7', '9']);
    });

    it('pins updated_at so the stamp is not mistaken for a change', async () => {
      applicationRepository.find.mockResolvedValue([application()]);

      await useCase.execute();

      // Being asked is not a change.
      const [sql] = applicationRepository.query.mock.calls[0] as [string];
      expect(sql).toContain('`updated_at` = `updated_at`');
    });

    it('does not even query when no enabled issuer reports outcomes separately', async () => {
      cardIssuerRegistry.keysWithCapability.mockReturnValue([]);

      await useCase.execute();

      expect(applicationRepository.find).not.toHaveBeenCalled();
    });

    it('reads only the columns it needs, leaving the retained payload behind', async () => {
      // `response_payload` is the largest column on the row and this path only
      // ever writes it, so an unnamed select would fetch a batch of retained
      // issuer payloads on every pass to discard them.
      await useCase.execute();

      const [options] = applicationRepository.find.mock.calls[0] as [
        { select: Record<string, boolean> },
      ];
      expect(options.select).not.toHaveProperty('responsePayload');
      expect(options.select).toMatchObject({ id: true, requestId: true });
    });

    it('calls no provider when nothing is awaiting an outcome', async () => {
      await useCase.execute();

      expect(cardIssuerRegistry.resolve).not.toHaveBeenCalled();
    });

    it('asks by the reference stored on the row', async () => {
      const row = application({ requestId: 'stored-reference' });
      applicationRepository.find.mockResolvedValueOnce([row]);
      const double = issuerDouble({ state: 'PENDING', rawPayload: {} });
      cardIssuerRegistry.resolve.mockReturnValueOnce(double);

      await useCase.execute();

      expect(double.getCardApplicationResult).toHaveBeenCalledWith(
        'stored-reference',
        {},
      );
    });
  });

  describe('an issued card', () => {
    const issued: CardApplicationOutcome = {
      state: 'ISSUED',
      statusRecognised: true,
      providerCardId: '30803710524000026680',
      maskedPan: '624673******6680',
      status: CardStatus.NOT_ACTIVATED,
      rawPayload: { card_id: '30803710524000026680', card_status: 3 },
    };

    beforeEach(() => {
      applicationRepository.find.mockResolvedValueOnce([application()]);
      cardIssuerRegistry.resolve.mockReturnValueOnce(issuerDouble(issued));
    });

    it('persists the identifiers and the status on the card', async () => {
      const row = card();
      cardRepository.findOne.mockResolvedValueOnce(row);

      await useCase.execute();

      expect(cardRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          providerCardId: '30803710524000026680',
          maskedPan: '624673******6680',
          status: CardStatus.NOT_ACTIVATED,
        }),
      );
    });

    it('records the transition as a card event', async () => {
      cardRepository.findOne.mockResolvedValueOnce(card());

      await useCase.execute();

      expect(eventRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          cardId: '10',
          fromStatus: CardStatus.NOT_ACTIVATED,
          toStatus: CardStatus.NOT_ACTIVATED,
          source: CardEventSource.RECONCILE,
        }),
      );
    });

    it('moves the application to approved and keeps their response for replay', async () => {
      cardRepository.findOne.mockResolvedValueOnce(card());

      await useCase.execute();

      expect(applicationRepository.update).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({
          status: CardApplicationStatus.APPROVED,
          reasonCode: null,
          message: null,
          responsePayload: issued.rawPayload,
        }),
      );
    });

    it('announces nothing while the card is still not usable', async () => {
      cardRepository.findOne.mockResolvedValueOnce(card());

      await useCase.execute();

      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
    });

    /**
     * The pass that watches a card become usable selects cards that are not
     * activated, so a card whose very first result already carries both the
     * card id and the issuer's activated status is resolved straight past that
     * selection and never seen by it.
     */
    it('announces a card that arrives already usable, since nothing else will', async () => {
      cardIssuerRegistry.resolve.mockReset();
      cardIssuerRegistry.resolve.mockReturnValueOnce(
        issuerDouble({
          state: 'ISSUED',
          statusRecognised: true,
          providerCardId: '30803710524000026680',
          status: CardStatus.ACTIVE,
          rawPayload: { card_status: 9 },
        }),
      );
      cardRepository.findOne.mockResolvedValueOnce(card());

      await useCase.execute();

      expect(webhookDeliveryService.enqueueForCard).toHaveBeenCalledWith(
        '10',
        '99',
        'card.activated',
        expect.objectContaining({
          eventType: 'card.activated',
          status: CardStatus.ACTIVE,
        }),
      );
    });

    it('keeps a masked number already stored when the outcome carries none', async () => {
      // An issuer that sends its identifiers separately can report the card id
      // before the number, so an absent one means "not sent this time" — and
      // blanking the stored value would lose the only copy.
      cardIssuerRegistry.resolve.mockReset();
      cardIssuerRegistry.resolve.mockReturnValueOnce(
        issuerDouble({
          state: 'ISSUED',
          statusRecognised: true,
          providerCardId: '30803710524000026680',
          status: CardStatus.NOT_ACTIVATED,
          rawPayload: {},
        }),
      );
      cardRepository.findOne.mockResolvedValueOnce(
        card({ maskedPan: '624673******6680' }),
      );

      await useCase.execute();

      expect(cardRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ maskedPan: '624673******6680' }),
      );
    });

    it('writes no second event for a card already carrying this result', async () => {
      cardRepository.findOne.mockResolvedValueOnce(
        card({
          providerCardId: '30803710524000026680',
          status: CardStatus.NOT_ACTIVATED,
        }),
      );

      await useCase.execute();

      expect(cardRepository.save).not.toHaveBeenCalled();
      expect(eventRepository.save).not.toHaveBeenCalled();
      // The application still settles — this is the path a retry after a failed
      // bookkeeping write takes.
      expect(applicationRepository.update).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({ status: CardApplicationStatus.APPROVED }),
      );
    });

    it('leaves the application alone when its card has gone', async () => {
      cardRepository.findOne.mockResolvedValueOnce(null);

      await useCase.execute();

      expect(applicationRepository.update).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('a refused application', () => {
    beforeEach(() => {
      applicationRepository.find.mockResolvedValueOnce([application()]);
      cardIssuerRegistry.resolve.mockReturnValueOnce(
        issuerDouble({
          state: 'REJECTED',
          reasonCode: 'D0006',
          reason: 'Incorrect name',
          rawPayload: { card_status: 4, fail_code: 'D0006' },
        }),
      );
    });

    it("records the issuer's code and prose on the application", async () => {
      await useCase.execute();

      expect(applicationRepository.update).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({
          status: CardApplicationStatus.REJECTED,
          reasonCode: 'D0006',
          message: 'Incorrect name',
          responsePayload: { card_status: 4, fail_code: 'D0006' },
        }),
      );
    });

    it('leaves the card row untouched', async () => {
      // `CardStatus` has no member meaning "refused" — `CLOSED` would claim the
      // card was closed, which is false about one never opened. The application
      // row is what carries a refusal.
      await useCase.execute();

      expect(cardRepository.save).not.toHaveBeenCalled();
      expect(eventRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('an application with no outcome yet', () => {
    it('writes nothing at all', async () => {
      applicationRepository.find.mockResolvedValueOnce([application()]);
      cardIssuerRegistry.resolve.mockReturnValueOnce(
        issuerDouble({ state: 'PENDING', rawPayload: { card_status: 1 } }),
      );

      await useCase.execute();

      expect(applicationRepository.update).not.toHaveBeenCalled();
      expect(cardRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('a reference the issuer does not hold', () => {
    it('leaves the row to be asked again, and says so', async () => {
      // This row records that the issuer acknowledged the application, and they
      // are now denying it. Marking it failed on their word alone would discard
      // our own evidence that the call succeeded.
      applicationRepository.find.mockResolvedValueOnce([application()]);
      cardIssuerRegistry.resolve.mockReturnValueOnce(
        issuerDouble({ state: 'UNKNOWN_REFERENCE' }),
      );

      await useCase.execute();

      expect(applicationRepository.update).not.toHaveBeenCalled();
      expect(cardRepository.save).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('does not hold card application'),
      );
    });
  });

  describe('isolation', () => {
    it("carries on past one application's failure", async () => {
      applicationRepository.find.mockResolvedValueOnce([
        application({ id: '1', requestId: 'first' }),
        application({ id: '2', requestId: 'second' }),
      ]);
      const failing = issuerDouble();
      failing.getCardApplicationResult.mockRejectedValueOnce(
        new Error('provider unreachable'),
      );
      const succeeding = issuerDouble({
        state: 'PENDING',
        rawPayload: {},
      });
      cardIssuerRegistry.resolve
        .mockReturnValueOnce(failing)
        .mockReturnValueOnce(succeeding);

      await useCase.execute();

      expect(succeeding.getCardApplicationResult).toHaveBeenCalledWith(
        'second',
        {},
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('provider unreachable'),
      );
    });

    it('survives a provider that is no longer enabled', async () => {
      // `resolve` throws for a key that has been switched off, and a sweep must
      // not die over one row's provider.
      applicationRepository.find.mockResolvedValueOnce([application()]);
      cardIssuerRegistry.resolve.mockImplementationOnce(() => {
        throw new Error('Card provider "HYPERCARD" is not enabled');
      });

      await expect(useCase.execute()).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    });
  });
  describe('resolving one application an issuer has named', () => {
    const ISSUED: CardApplicationOutcome = {
      state: 'ISSUED',
      statusRecognised: true,
      providerCardId: '6232931889900031321',
      status: CardStatus.ACTIVE,
      rawPayload: {},
    };

    it('selects on the same predicate the pass does, narrowed to one reference', async () => {
      applicationRepository.findOne.mockResolvedValue(application());
      cardIssuerRegistry.resolve.mockReturnValue(issuerDouble(ISSUED));
      cardRepository.findOne.mockResolvedValue(card());

      await useCase.resolveOneByRequestId(
        CardProviderKey.HYPERCARD,
        '7e679210e88f4d6abbe21a2b39b0ceed',
        CardEventSource.CALLBACK,
      );

      expect(applicationRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: CardApplicationStatus.SUBMITTED,
            providerKey: CardProviderKey.HYPERCARD,
            requestId: '7e679210e88f4d6abbe21a2b39b0ceed',
          },
        }),
      );
    });

    it('asks the issuer and records the outcome, as the pass would', async () => {
      applicationRepository.findOne.mockResolvedValue(application());
      const issuer = issuerDouble(ISSUED);
      cardIssuerRegistry.resolve.mockReturnValue(issuer);
      cardRepository.findOne.mockResolvedValue(card());

      await expect(
        useCase.resolveOneByRequestId(
          CardProviderKey.HYPERCARD,
          '7e679210e88f4d6abbe21a2b39b0ceed',
          CardEventSource.CALLBACK,
        ),
      ).resolves.toBe('RESOLVED');

      expect(issuer.getCardApplicationResult).toHaveBeenCalledWith(
        '7e679210e88f4d6abbe21a2b39b0ceed',
        {},
      );
      expect(applicationRepository.update).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({ status: CardApplicationStatus.APPROVED }),
      );
    });

    it('records how the transition was learned of, not that a timer noticed', async () => {
      applicationRepository.findOne.mockResolvedValue(application());
      cardIssuerRegistry.resolve.mockReturnValue(issuerDouble(ISSUED));
      cardRepository.findOne.mockResolvedValue(card());

      await useCase.resolveOneByRequestId(
        CardProviderKey.HYPERCARD,
        '7e679210e88f4d6abbe21a2b39b0ceed',
        CardEventSource.CALLBACK,
      );

      expect(eventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ source: CardEventSource.CALLBACK }),
      );
    });

    it('takes the rotation stamp, so the row does not hold the head of every later pass', async () => {
      applicationRepository.findOne.mockResolvedValue(application());
      cardIssuerRegistry.resolve.mockReturnValue(
        issuerDouble({ state: 'PENDING', rawPayload: {} }),
      );

      await useCase.resolveOneByRequestId(
        CardProviderKey.HYPERCARD,
        '7e679210e88f4d6abbe21a2b39b0ceed',
        CardEventSource.CALLBACK,
      );

      expect(applicationRepository.query).toHaveBeenCalledWith(
        expect.stringContaining('status_checked_at'),
        expect.arrayContaining(['1']) as unknown[],
      );
    });

    it('answers that nothing was resolved when no row is outstanding', async () => {
      applicationRepository.findOne.mockResolvedValue(null);

      await expect(
        useCase.resolveOneByRequestId(
          CardProviderKey.HYPERCARD,
          'a-reference-from-somewhere-else',
          CardEventSource.CALLBACK,
        ),
      ).resolves.toBe('NO_ROW');
      expect(cardIssuerRegistry.resolve).not.toHaveBeenCalled();
    });

    it('never asks a provider that reports no outcome separately', async () => {
      // The pass keeps such rows out in SQL; nothing else would here.
      cardIssuerRegistry.keysWithCapability.mockReturnValue([]);

      await expect(
        useCase.resolveOneByRequestId(
          CardProviderKey.HYPERCARD,
          '7e679210e88f4d6abbe21a2b39b0ceed',
          CardEventSource.CALLBACK,
        ),
      ).resolves.toBe('NO_ROW');
      expect(applicationRepository.findOne).not.toHaveBeenCalled();
    });
  });
});
