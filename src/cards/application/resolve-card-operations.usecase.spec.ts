import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, In, IsNull, LessThan } from 'typeorm';
import { WebhookDeliveryService } from '../../payments/infrastructure/webhooks/webhook-delivery.service';
import { CardCapability } from '../domain/card-capability.enum';
import { CardEventSource } from '../domain/card-event-source.enum';
import {
  CardIssuerPort,
  CardOperationOutcome,
} from '../domain/card-issuer.port';
import { CardLifecycleOperation } from '../domain/card-lifecycle-operation.enum';
import { CardOperationStatus } from '../domain/card-operation-status.enum';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardCallbackResolution } from './card-callback-resolution';
import { CardEventEntity } from '../infrastructure/persistence/card-event.entity';
import { CardOperationEntity } from '../infrastructure/persistence/card-operation.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { ResolveCardOperationsUseCase } from './resolve-card-operations.usecase';

describe('ResolveCardOperationsUseCase', () => {
  let useCase: ResolveCardOperationsUseCase;
  let operationRepository: {
    find: jest.Mock;
    findAndCount: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    query: jest.Mock;
  };
  let cardRepository: { find: jest.Mock; update: jest.Mock; save: jest.Mock };
  let eventRepository: { create: jest.Mock; save: jest.Mock };
  let cardIssuerRegistry: { resolve: jest.Mock; keysWithCapability: jest.Mock };
  let webhookDeliveryService: { enqueueForCard: jest.Mock };
  let warnSpy: jest.SpyInstance;

  const BATCH_SIZE = 50;
  const ESCALATION_AFTER_SECONDS = 345_600;
  const PROVIDER_CARD_ID = '30830869524000023908';
  const REFERENCE = '53e24a55-d028-4225-a810-9ab4398c0738';

  /**
   * The stamp is `new Date()` inside the pass, so only its type can be
   * asserted. Named and typed here because `expect.any` is `any`, which the
   * lint rules refuse inside an object literal.
   */
  const ANY_DATE = expect.any(Date) as unknown as Date;

  const config: Record<string, number> = {
    CARD_OPERATION_SWEEP_BATCH_SIZE: BATCH_SIZE,
    CARD_OPERATION_ESCALATION_AFTER_SECONDS: ESCALATION_AFTER_SECONDS,
  };

  /** One recorded call's arguments. */
  const callArguments = (mock: jest.Mock, index = 0): unknown[] =>
    (mock.mock.calls[index] ?? []) as unknown[];

  /** The columns one operation `update` call actually set. */
  const writtenColumns = (index = 0): Record<string, unknown> => {
    const [, changes] = callArguments(operationRepository.update, index);
    return changes as Record<string, unknown>;
  };

  const card = (overrides: Partial<CardEntity> = {}): CardEntity =>
    ({
      id: '10',
      publicId: 'card-public-id',
      partnerId: '99',
      providerCardId: PROVIDER_CARD_ID,
      status: CardStatus.ACTIVE,
      ...overrides,
    }) as CardEntity;

  const operation = (
    overrides: Partial<CardOperationEntity> = {},
  ): CardOperationEntity =>
    ({
      id: '1',
      cardId: '10',
      providerKey: CardProviderKey.HYPERCARD,
      requestReference: REFERENCE,
      operationType: CardLifecycleOperation.BLOCK,
      status: CardOperationStatus.SUBMITTED,
      createdAt: new Date('2026-08-20T10:00:00.000Z'),
      ...overrides,
    }) as CardOperationEntity;

  // Typed against the port so the double cannot drift from the interface it
  // stands in for.
  type IssuerDouble = Pick<CardIssuerPort, 'capabilities'> & {
    getCardOperationResult: jest.Mock;
  };

  const issuerDouble = (outcome?: CardOperationOutcome): IssuerDouble => ({
    capabilities: new Set([
      CardCapability.BLOCK,
      CardCapability.OPERATION_RESULT,
    ]),
    getCardOperationResult: jest.fn().mockResolvedValue(outcome),
  });

  /** Stands in for a transaction's manager, so writes assert the same way. */
  const managerFor = (): unknown => ({
    getRepository: (entity: unknown) => {
      if (entity === CardEntity) return cardRepository;
      if (entity === CardEventEntity) return eventRepository;
      return operationRepository;
    },
  });

  /** The ordinary arrangement: one outstanding operation and its card. */
  const seed = (
    outcome: CardOperationOutcome,
    operationOverrides: Partial<CardOperationEntity> = {},
    cardOverrides: Partial<CardEntity> = {},
  ): IssuerDouble => {
    operationRepository.findAndCount.mockResolvedValue([
      [operation(operationOverrides)],
      1,
    ]);
    cardRepository.find.mockResolvedValue([card(cardOverrides)]);
    const adapter = issuerDouble(outcome);
    cardIssuerRegistry.resolve.mockReturnValue(adapter);
    return adapter;
  };

  beforeEach(async () => {
    operationRepository = {
      find: jest.fn().mockResolvedValue([]),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      findOne: jest.fn().mockResolvedValue(null),
      // One row matched, which is the ordinary outcome of the conditional
      // write. A case that wants the lost race says so explicitly.
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      query: jest.fn(),
    };
    // The write methods are stubbed even though most cases should not call
    // them: a double that simply lacks them turns "this pass writes the card"
    // into a TypeError the per-row catch swallows, so the case asserting it
    // does not would pass either way.
    cardRepository = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn(),
    };
    eventRepository = {
      create: jest.fn((row: unknown) => row),
      save: jest.fn(),
    };
    cardIssuerRegistry = {
      resolve: jest.fn(),
      keysWithCapability: jest
        .fn()
        .mockReturnValue([CardProviderKey.HYPERCARD]),
    };
    webhookDeliveryService = { enqueueForCard: jest.fn() };

    // Every per-row failure is swallowed into logger.warn, so without this spy
    // a crash inside the loop is indistinguishable from a clean skip and the
    // negative assertions below would pass vacuously.
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResolveCardOperationsUseCase,
        {
          provide: getRepositoryToken(CardOperationEntity),
          useValue: operationRepository,
        },
        { provide: getRepositoryToken(CardEntity), useValue: cardRepository },
        { provide: CardIssuerRegistry, useValue: cardIssuerRegistry },
        { provide: WebhookDeliveryService, useValue: webhookDeliveryService },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn((key: string) => config[key]),
          },
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

    useCase = module.get(ResolveCardOperationsUseCase);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('selection', () => {
    /** The whole query, asserted exactly rather than in parts. */
    it('asks only for outstanding operations at issuers that can answer', async () => {
      await useCase.execute();

      expect(operationRepository.findAndCount).toHaveBeenCalledWith({
        where: {
          // Derived, so a status added later is polled rather than ignored —
          // and `DRAFT` is deliberately absent, because no reference for one
          // ever reached the issuer.
          status: In([CardOperationStatus.SUBMITTED]),
          providerKey: In([CardProviderKey.HYPERCARD]),
        },
        select: {
          id: true,
          cardId: true,
          providerKey: true,
          requestReference: true,
          operationType: true,
          status: true,
          createdAt: true,
        },
        order: { statusCheckedAt: 'ASC', id: 'ASC' },
        take: BATCH_SIZE,
      });
    });

    it('asks the registry for the lookup capability, not the block one', async () => {
      // The two are separate flags because an issuer that applies the change
      // during the call has no outcome to fetch — selecting on BLOCK would put
      // its rows in a batch nothing can ever answer for.
      await useCase.execute();

      expect(cardIssuerRegistry.keysWithCapability).toHaveBeenCalledWith(
        CardCapability.OPERATION_RESULT,
      );
    });

    it('queries nothing at all when no issuer can answer a lookup', async () => {
      cardIssuerRegistry.keysWithCapability.mockReturnValue([]);

      await useCase.execute();

      expect(operationRepository.findAndCount).not.toHaveBeenCalled();
    });

    it('still escalates when the lookup half fails outright', async () => {
      // A failure outside the per-row isolation must not take escalation with
      // it: a row stranded before its issuer call is all escalation ever sees.
      operationRepository.findAndCount.mockRejectedValue(
        new Error('lock wait timeout'),
      );

      await expect(useCase.execute()).resolves.toBeUndefined();

      expect(operationRepository.find).toHaveBeenCalled();
    });

    it('still escalates when no issuer can answer a lookup', async () => {
      // The halves are guarded separately on purpose: a row stranded before
      // its issuer call belongs to no lookup, and nothing else will see it.
      cardIssuerRegistry.keysWithCapability.mockReturnValue([]);

      await useCase.execute();

      expect(operationRepository.find).toHaveBeenCalled();
    });
  });

  describe('the rotation stamp', () => {
    it('stamps the whole batch before examining any of it', async () => {
      seed({ state: 'PENDING' });

      await useCase.execute();

      const [sql, parameters] = callArguments(operationRepository.query) as [
        string,
        unknown[],
      ];
      expect(sql).toContain('UPDATE `card_operation`');
      expect(sql).toContain('`status_checked_at` = ?');
      // Assigned to itself, because the column is ON UPDATE
      // CURRENT_TIMESTAMP(6) and fires whatever the SET list names. Being
      // asked is not a change.
      expect(sql).toContain('`updated_at` = `updated_at`');
      expect(parameters).toEqual([ANY_DATE, '1']);
    });

    it('stamps an operation the issuer would not answer for', async () => {
      // The stamp records that the pass looked, not that the look worked — or
      // one unanswerable row starves everything behind it on a set that never
      // drains on its own.
      const adapter = seed({ state: 'PENDING' });
      adapter.getCardOperationResult.mockRejectedValue(new Error('timeout'));

      await useCase.execute();

      expect(operationRepository.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('asking the issuer', () => {
    it('asks with the stored reference and the stored operation', async () => {
      const adapter = seed({ state: 'PENDING' });

      await useCase.execute();

      expect(adapter.getCardOperationResult).toHaveBeenCalledWith(
        PROVIDER_CARD_ID,
        REFERENCE,
        CardLifecycleOperation.BLOCK,
        {},
      );
    });

    it('writes nothing while the issuer has no outcome yet', async () => {
      seed({ state: 'PENDING', rawPayload: { operate_status: 99 } });

      await useCase.execute();

      expect(operationRepository.update).not.toHaveBeenCalled();
      expect(cardRepository.update).not.toHaveBeenCalled();
      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
    });

    it('leaves an operation the issuer does not hold exactly as it was', async () => {
      seed({ state: 'UNKNOWN_REFERENCE' });

      await useCase.execute();

      expect(operationRepository.update).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('does not hold'),
      );
    });

    it('keeps a failure on one operation from aborting the pass', async () => {
      operationRepository.findAndCount.mockResolvedValue([
        [operation(), operation({ id: '2', cardId: '11' })],
        2,
      ]);
      cardRepository.find.mockResolvedValue([card(), card({ id: '11' })]);
      const adapter = issuerDouble();
      adapter.getCardOperationResult
        .mockRejectedValueOnce(new Error('transport exploded'))
        .mockResolvedValueOnce({ state: 'APPLIED', rawPayload: {} });
      cardIssuerRegistry.resolve.mockReturnValue(adapter);

      await useCase.execute();

      expect(adapter.getCardOperationResult).toHaveBeenCalledTimes(2);
      expect(operationRepository.update).toHaveBeenCalledTimes(1);
    });

    it('skips a row whose card carries no issuer card id', async () => {
      seed({ state: 'APPLIED', rawPayload: {} }, {}, { providerCardId: null });

      await useCase.execute();

      expect(cardIssuerRegistry.resolve).not.toHaveBeenCalled();
      expect(operationRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('an operation the issuer carried out', () => {
    const applied = (): CardOperationOutcome => ({
      state: 'APPLIED',
      rawPayload: { operate_status: 1 },
    });

    it('records the operation against the status this pass read', async () => {
      seed(applied());

      await useCase.execute();

      expect(callArguments(operationRepository.update)[0]).toEqual({
        id: '1',
        status: CardOperationStatus.SUBMITTED,
      });
      expect(writtenColumns()).toEqual({
        status: CardOperationStatus.APPLIED,
        reasonCode: null,
        message: null,
        responsePayload: { operate_status: 1 },
      });
    });

    it('moves a blocked card to on hold, conditional on the status it read', async () => {
      seed(applied());

      await useCase.execute();

      expect(cardRepository.update).toHaveBeenCalledWith(
        { id: '10', status: CardStatus.ACTIVE },
        { status: CardStatus.ON_HOLD },
      );
    });

    it('moves an unblocked card back to active', async () => {
      seed(
        applied(),
        { operationType: CardLifecycleOperation.UNBLOCK },
        { status: CardStatus.ON_HOLD },
      );

      await useCase.execute();

      expect(cardRepository.update).toHaveBeenCalledWith(
        { id: '10', status: CardStatus.ON_HOLD },
        { status: CardStatus.ACTIVE },
      );
    });

    it('records the transition as the issuer having moved the card, not a member of staff', async () => {
      seed(applied());

      await useCase.execute();

      expect(eventRepository.save).toHaveBeenCalledWith({
        cardId: '10',
        fromStatus: CardStatus.ACTIVE,
        toStatus: CardStatus.ON_HOLD,
        source: CardEventSource.RECONCILE,
        detail: null,
      });
    });

    it('tells the partner the card moved', async () => {
      seed(applied());

      await useCase.execute();

      expect(webhookDeliveryService.enqueueForCard).toHaveBeenCalledWith(
        '10',
        '99',
        'card.status_updated',
        expect.objectContaining({
          eventType: 'card.status_updated',
          cardPublicId: 'card-public-id',
          status: CardStatus.ON_HOLD,
        }),
      );
    });

    it('writes and announces nothing about a card already where it belongs', async () => {
      // The event and the notification describe a transition, not a state.
      seed(applied(), {}, { status: CardStatus.ON_HOLD });

      await useCase.execute();

      expect(operationRepository.update).toHaveBeenCalledTimes(1);
      expect(cardRepository.update).not.toHaveBeenCalled();
      expect(eventRepository.save).not.toHaveBeenCalled();
      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
    });

    it.each([
      ['a closed card', CardStatus.CLOSED],
      ['a card that was never activated', CardStatus.NOT_ACTIVATED],
    ])('records the operation but never moves %s', async (_label, status) => {
      // The conditional write cannot catch this: it keys on the status this
      // pass read, which matches, so an unguarded write would take a terminal
      // card back into a spendable state.
      seed(applied(), {}, { status });

      await useCase.execute();

      expect(operationRepository.update).toHaveBeenCalledTimes(1);
      expect(cardRepository.update).not.toHaveBeenCalled();
      expect(eventRepository.save).not.toHaveBeenCalled();
      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('no lifecycle operation acts on'),
      );
    });

    it('leaves the card alone for an operation that does not move one', async () => {
      seed(applied(), { operationType: CardLifecycleOperation.CHANGE_PIN });

      await useCase.execute();

      expect(operationRepository.update).toHaveBeenCalledTimes(1);
      expect(cardRepository.update).not.toHaveBeenCalled();
      expect(eventRepository.save).not.toHaveBeenCalled();
    });

    it('writes nothing further when something else moved the operation first', async () => {
      seed(applied());
      operationRepository.update.mockResolvedValue({ affected: 0 });

      await useCase.execute();

      expect(cardRepository.update).not.toHaveBeenCalled();
      expect(eventRepository.save).not.toHaveBeenCalled();
      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
    });

    it('keeps the operation recorded but announces nothing when the card was moved underneath it', async () => {
      // The issuer really did carry the operation out, whatever else moved the
      // card meanwhile — but the event and the notification would describe a
      // transition this pass did not make.
      seed(applied());
      cardRepository.update.mockResolvedValue({ affected: 0 });

      await useCase.execute();

      expect(operationRepository.update).toHaveBeenCalledTimes(1);
      expect(eventRepository.save).not.toHaveBeenCalled();
      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('changed by something else'),
      );
    });
  });

  describe('an operation the issuer refused to carry out', () => {
    const failed = (
      overrides: Partial<
        Extract<CardOperationOutcome, { state: 'FAILED' }>
      > = {},
    ): CardOperationOutcome => ({
      state: 'FAILED',
      rawPayload: { operate_status: 2 },
      ...overrides,
    });

    it('never touches the card, which never changed state', async () => {
      seed(failed());

      await useCase.execute();

      expect(cardRepository.update).not.toHaveBeenCalled();
      expect(eventRepository.save).not.toHaveBeenCalled();
    });

    it('composes a message when the issuer gives no reason', async () => {
      // One issuer publishes no reason field on this lookup at all, so the
      // composed sentence is the only thing a partner can read.
      seed(failed());

      await useCase.execute();

      expect(writtenColumns()).toMatchObject({
        status: CardOperationStatus.FAILED,
        reasonCode: null,
        message:
          'The card provider did not carry out this BLOCK and gave no reason',
      });
    });

    it('prefers the words of an issuer that publishes any', async () => {
      seed(failed({ reasonCode: 'E0001', reason: 'Card not eligible' }));

      await useCase.execute();

      expect(writtenColumns()).toMatchObject({
        reasonCode: 'E0001',
        message: 'Card not eligible',
      });
    });

    it('composes a message when the issuer reports an empty reason', async () => {
      // An issuer whose empty value is `""` rather than an absent key would
      // otherwise store a blank, which the card read publishes as the reason.
      seed(failed({ reasonCode: '', reason: '   ' }));

      await useCase.execute();

      expect(writtenColumns()).toMatchObject({
        reasonCode: null,
        message:
          'The card provider did not carry out this BLOCK and gave no reason',
      });
    });

    it('truncates an over-long reason to the column that holds it', async () => {
      seed(failed({ reasonCode: 'E'.repeat(80), reason: 'x'.repeat(400) }));

      await useCase.execute();

      const { reasonCode, message } = writtenColumns() as {
        reasonCode: string;
        message: string;
      };
      expect(reasonCode).toHaveLength(40);
      expect(message).toHaveLength(255);
    });

    it('tells the partner the operation failed, not that the card moved', async () => {
      seed(failed());

      await useCase.execute();

      expect(webhookDeliveryService.enqueueForCard).toHaveBeenCalledTimes(1);
      expect(webhookDeliveryService.enqueueForCard).toHaveBeenCalledWith(
        '10',
        '99',
        'card_operation.failed',
        expect.objectContaining({
          eventType: 'card_operation.failed',
          cardPublicId: 'card-public-id',
          operation: CardLifecycleOperation.BLOCK,
          status: CardOperationStatus.FAILED,
        }),
      );
    });

    it('announces nothing when something else moved the operation first', async () => {
      seed(failed());
      operationRepository.update.mockResolvedValue({ affected: 0 });

      await useCase.execute();

      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
    });
  });

  describe('escalation', () => {
    const stale = (): CardOperationEntity =>
      operation({ createdAt: new Date(Date.now() - 10 * 86_400_000) });

    it('looks for the operations holding a card, which includes the unpolled one', async () => {
      // Wider than the lookup's selection deliberately: a row written before
      // an issuer call and stranded there holds its card for ever, and no
      // lookup will ever see it because the issuer was never sent it.
      await useCase.execute();

      expect(operationRepository.find).toHaveBeenCalledWith({
        where: {
          status: In([
            CardOperationStatus.DRAFT,
            CardOperationStatus.SUBMITTED,
          ]),
          escalatedAt: IsNull(),
          createdAt: LessThan(ANY_DATE),
        },
        select: expect.anything() as unknown as Record<string, boolean>,
        order: { createdAt: 'ASC', id: 'ASC' },
        take: BATCH_SIZE,
      });
    });

    it('stamps a stale operation once and warns about it', async () => {
      operationRepository.find.mockResolvedValue([stale()]);
      cardRepository.find.mockResolvedValue([card()]);

      await useCase.execute();

      // One row at a time, so the warning below describes what this pass
      // actually stamped rather than how many rows a batch write moved.
      expect(operationRepository.update).toHaveBeenCalledWith(
        { id: '1', escalatedAt: IsNull() },
        { escalatedAt: ANY_DATE },
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('needs somebody to take it up'),
      );
    });

    it('never moves a status', async () => {
      // Inventing a terminal state for an operation the issuer has not
      // answered is exactly what the lookup refuses to do from an unreadable
      // code; the horizon passing is not better evidence than that.
      operationRepository.find.mockResolvedValue([stale()]);

      await useCase.execute();

      expect(writtenColumns()).toEqual({ escalatedAt: ANY_DATE });
    });

    it('says nothing about a row another pass stamped first', async () => {
      // Nothing holds a distributed lock, so two instances reach the same row.
      operationRepository.find.mockResolvedValue([stale()]);
      operationRepository.update.mockResolvedValue({ affected: 0 });

      await useCase.execute();

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('warns only about the rows it stamped', async () => {
      operationRepository.find.mockResolvedValue([
        stale(),
        { ...stale(), id: '2' } as CardOperationEntity,
      ]);
      cardRepository.find.mockResolvedValue([card()]);
      operationRepository.update
        .mockResolvedValueOnce({ affected: 0 })
        .mockResolvedValueOnce({ affected: 1 });

      await useCase.execute();

      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('writes nothing when nothing is stale', async () => {
      await useCase.execute();

      expect(operationRepository.update).not.toHaveBeenCalled();
    });
  });
  describe('resolving one operation an issuer has named', () => {
    const APPLIED: CardOperationOutcome = {
      state: 'APPLIED',
      rawPayload: { operate_status: '1' },
    };

    const resolveOne = (
      reference = REFERENCE,
    ): Promise<CardCallbackResolution> =>
      useCase.resolveOneByRequestReference(
        CardProviderKey.HYPERCARD,
        reference,
        CardEventSource.CALLBACK,
      );

    it('selects on the same predicate the pass does, narrowed to one reference', async () => {
      operationRepository.findOne.mockResolvedValue(operation());
      cardRepository.find.mockResolvedValue([card()]);
      cardIssuerRegistry.resolve.mockReturnValue(issuerDouble(APPLIED));

      await resolveOne();

      const [options] = callArguments(operationRepository.findOne);
      const where = (
        options as {
          where: {
            requestReference: string;
            providerKey: string;
            status: { value: CardOperationStatus[] };
          };
        }
      ).where;
      expect(where.requestReference).toBe(REFERENCE);
      expect(where.providerKey).toBe(CardProviderKey.HYPERCARD);
      expect(where.status.value).toContain(CardOperationStatus.SUBMITTED);
      expect(where.status.value).not.toContain(CardOperationStatus.APPLIED);
    });

    it('asks the issuer rather than reading the outcome the push carried', async () => {
      // The push carries the same field the lookup returns, and a stale one
      // arrives after a fresher one.
      operationRepository.findOne.mockResolvedValue(operation());
      cardRepository.find.mockResolvedValue([card()]);
      const adapter = issuerDouble(APPLIED);
      cardIssuerRegistry.resolve.mockReturnValue(adapter);

      await expect(resolveOne()).resolves.toBe('RESOLVED');

      expect(adapter.getCardOperationResult).toHaveBeenCalledWith(
        PROVIDER_CARD_ID,
        REFERENCE,
        CardLifecycleOperation.BLOCK,
        {},
      );
      expect(writtenColumns()).toMatchObject({
        status: CardOperationStatus.APPLIED,
      });
      expect(cardRepository.update).toHaveBeenCalledWith(
        { id: '10', status: CardStatus.ACTIVE },
        { status: CardStatus.ON_HOLD },
      );
    });

    it('records how the transition was learned of, not that a timer noticed', async () => {
      operationRepository.findOne.mockResolvedValue(operation());
      cardRepository.find.mockResolvedValue([card()]);
      cardIssuerRegistry.resolve.mockReturnValue(issuerDouble(APPLIED));

      await resolveOne();

      expect(eventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ source: CardEventSource.CALLBACK }),
      );
    });

    it('takes the rotation stamp, so the row does not hold the head of every later pass', async () => {
      operationRepository.findOne.mockResolvedValue(operation());
      cardRepository.find.mockResolvedValue([card()]);
      cardIssuerRegistry.resolve.mockReturnValue(
        issuerDouble({ state: 'PENDING' }),
      );

      await resolveOne();

      expect(operationRepository.query).toHaveBeenCalledWith(
        expect.stringContaining('status_checked_at'),
        expect.arrayContaining([ANY_DATE, '1']) as unknown[],
      );
    });

    it('answers that nothing was resolved when no row is outstanding', async () => {
      operationRepository.findOne.mockResolvedValue(null);

      await expect(resolveOne('an-outsider')).resolves.toBe('NO_ROW');
      expect(cardIssuerRegistry.resolve).not.toHaveBeenCalled();
    });

    it('never asks a provider that reports no outcome separately', async () => {
      cardIssuerRegistry.keysWithCapability.mockReturnValue([]);

      await expect(resolveOne()).resolves.toBe('NO_ROW');
      expect(operationRepository.findOne).not.toHaveBeenCalled();
    });

    it('says so rather than asking when the card carries no issuer id', async () => {
      operationRepository.findOne.mockResolvedValue(operation());
      cardRepository.find.mockResolvedValue([card({ providerCardId: null })]);

      await expect(resolveOne()).resolves.toBe('UNRESOLVABLE');
      expect(cardIssuerRegistry.resolve).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('no issuer card id'),
      );
    });
  });
});
