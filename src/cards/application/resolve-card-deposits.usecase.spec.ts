import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { WebhookDeliveryService } from '../../payments/infrastructure/webhooks/webhook-delivery.service';
import { CardCapability } from '../domain/card-capability.enum';
import { CardDepositStatus } from '../domain/card-deposit-status.enum';
import { CardDepositOutcome, CardIssuerPort } from '../domain/card-issuer.port';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardCallbackResolution } from './card-callback-resolution';
import { CardDepositEntity } from '../infrastructure/persistence/card-deposit.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { ResolveCardDepositsUseCase } from './resolve-card-deposits.usecase';

describe('ResolveCardDepositsUseCase', () => {
  let useCase: ResolveCardDepositsUseCase;
  let depositRepository: {
    findAndCount: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    query: jest.Mock;
  };
  let cardRepository: { find: jest.Mock; update: jest.Mock; save: jest.Mock };
  let cardIssuerRegistry: { resolve: jest.Mock; keysWithCapability: jest.Mock };
  let webhookDeliveryService: { enqueueForCard: jest.Mock };
  let warnSpy: jest.SpyInstance;

  const BATCH_SIZE = 50;
  const PROVIDER_CARD_ID = '30806984524000022826';
  const DEPOSIT_PUBLIC_ID = 'b2e571af-86c0-4bee-a535-2fb79fd8f852';
  const THEIR_DEPOSIT_ID = '20260818213657805143';

  /**
   * The stamp is `new Date()` inside the pass, so only its type can be
   * asserted. Named and typed here because `expect.any` is `any`, which the
   * lint rules refuse inside an object literal.
   */
  const ANY_DATE = expect.any(Date) as unknown as Date;

  /** One recorded call's arguments. */
  const callArguments = (mock: jest.Mock, index = 0): unknown[] =>
    (mock.mock.calls[index] ?? []) as unknown[];

  /** The status list one `findAndCount` call actually selected on. */
  const selectedStatuses = (): CardDepositStatus[] => {
    const [query] = callArguments(depositRepository.findAndCount);
    return (query as { where: { status: { value: CardDepositStatus[] } } })
      .where.status.value;
  };

  /** The columns one `update` call actually set. */
  const writtenColumns = (): Record<string, unknown> => {
    const [, changes] = callArguments(depositRepository.update);
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

  const deposit = (
    overrides: Partial<CardDepositEntity> = {},
  ): CardDepositEntity =>
    ({
      id: '1',
      publicId: DEPOSIT_PUBLIC_ID,
      cardId: '10',
      providerKey: CardProviderKey.HYPERCARD,
      requestId: 'partner-key-1',
      providerReference: DEPOSIT_PUBLIC_ID,
      providerDepositId: THEIR_DEPOSIT_ID,
      currencyCode: 'USD',
      status: CardDepositStatus.SUBMITTED,
      creditedAmount: null,
      reasonCode: null,
      message: null,
      ...overrides,
    }) as CardDepositEntity;

  const settled = (
    overrides: Partial<Extract<CardDepositOutcome, { state: 'SETTLED' }>> = {},
  ): CardDepositOutcome =>
    ({
      state: 'SETTLED',
      creditedAmount: '10',
      creditedCurrencyCode: 'usd',
      providerDepositId: THEIR_DEPOSIT_ID,
      rawPayload: { status: 1 },
      ...overrides,
    }) satisfies CardDepositOutcome;

  // Typed against the port so the double cannot drift from the interface it
  // stands in for.
  type IssuerDouble = Pick<CardIssuerPort, 'capabilities'> & {
    getCardDepositResult: jest.Mock;
  };

  const issuerDouble = (outcome?: CardDepositOutcome): IssuerDouble => ({
    capabilities: new Set([CardCapability.DEPOSIT]),
    getCardDepositResult: jest.fn().mockResolvedValue(outcome),
  });

  /** The ordinary arrangement: one outstanding deposit and the card it is on. */
  const seed = (
    outcome: CardDepositOutcome,
    depositOverrides: Partial<CardDepositEntity> = {},
    cardOverrides: Partial<CardEntity> = {},
  ): IssuerDouble => {
    depositRepository.findAndCount.mockResolvedValue([
      [deposit(depositOverrides)],
      1,
    ]);
    cardRepository.find.mockResolvedValue([card(cardOverrides)]);
    const adapter = issuerDouble(outcome);
    cardIssuerRegistry.resolve.mockReturnValue(adapter);
    return adapter;
  };

  beforeEach(async () => {
    depositRepository = {
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      findOne: jest.fn().mockResolvedValue(null),
      // One row matched, which is the ordinary outcome of the conditional
      // write. A case that wants the lost race says so explicitly.
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      query: jest.fn(),
    };
    // The write methods are stubbed even though nothing should call them: a
    // double that simply lacks them turns "this pass writes the card" into a
    // TypeError the per-row catch swallows, so the case asserting it does not
    // would pass either way.
    cardRepository = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
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
        ResolveCardDepositsUseCase,
        {
          provide: getRepositoryToken(CardDepositEntity),
          useValue: depositRepository,
        },
        { provide: getRepositoryToken(CardEntity), useValue: cardRepository },
        { provide: CardIssuerRegistry, useValue: cardIssuerRegistry },
        { provide: WebhookDeliveryService, useValue: webhookDeliveryService },
        {
          provide: ConfigService,
          useValue: { getOrThrow: jest.fn().mockReturnValue(BATCH_SIZE) },
        },
      ],
    }).compile();

    useCase = module.get(ResolveCardDepositsUseCase);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('selection', () => {
    /** The whole query, asserted exactly rather than in parts. */
    it('asks only for outstanding deposits at issuers that can answer', async () => {
      await useCase.execute();

      expect(depositRepository.findAndCount).toHaveBeenCalledWith({
        where: {
          status: In([
            CardDepositStatus.SUBMITTED,
            CardDepositStatus.FAILED,
            CardDepositStatus.REFUND_PENDING,
          ]),
          providerKey: In([CardProviderKey.HYPERCARD]),
        },
        select: {
          id: true,
          publicId: true,
          cardId: true,
          providerKey: true,
          requestId: true,
          providerReference: true,
          providerDepositId: true,
          currencyCode: true,
          status: true,
          creditedAmount: true,
          reasonCode: true,
          message: true,
        },
        order: { statusCheckedAt: 'ASC', id: 'ASC' },
        take: BATCH_SIZE,
      });
    });

    it.each([
      ['their settled state', CardDepositStatus.SETTLED],
      ['their refunded state', CardDepositStatus.REFUNDED],
      ['a request they refused outright', CardDepositStatus.REJECTED],
      ['a row the issuer was never called for', CardDepositStatus.DRAFT],
      ['a call that never landed', CardDepositStatus.SUBMISSION_FAILED],
    ])('never selects %s', async (_label, status) => {
      await useCase.execute();

      expect(selectedStatuses()).not.toContain(status);
    });

    it('keeps watching a deposit the issuer failed', async () => {
      // The criterion this whole pass turns on.
      await useCase.execute();

      expect(selectedStatuses()).toContain(CardDepositStatus.FAILED);
    });

    it('queries nothing at all when no issuer takes deposits by request', async () => {
      cardIssuerRegistry.keysWithCapability.mockReturnValue([]);

      await useCase.execute();

      expect(depositRepository.findAndCount).not.toHaveBeenCalled();
    });

    it('gates on the deposit capability', async () => {
      await useCase.execute();

      expect(cardIssuerRegistry.keysWithCapability).toHaveBeenCalledWith(
        CardCapability.DEPOSIT,
      );
    });
  });

  describe('the rotation stamp', () => {
    it('stamps the whole batch before any row is examined', async () => {
      const adapter = seed(settled());

      await useCase.execute();

      // Ordered, not merely both present: the stamp is what stops one
      // unanswerable deposit holding the head of the queue for ever, and a
      // stamp written afterwards would be skipped by exactly the rows that need
      // it — the ones whose examination threw.
      expect(depositRepository.query.mock.invocationCallOrder[0]).toBeLessThan(
        adapter.getCardDepositResult.mock.invocationCallOrder[0] as number,
      );
    });

    it('writes it with a bound statement that leaves updated_at alone', async () => {
      // Two separate mechanisms would move `updated_at` here and the statement
      // has to defeat both: TypeORM adds `@UpdateDateColumn` to every SET
      // clause, which is why this is raw SQL, and the column is additionally
      // `ON UPDATE CURRENT_TIMESTAMP(6)` in the migration, which fires
      // whatever the SET list names — so the self-assignment is what
      // suppresses it.
      seed(settled());

      await useCase.execute();

      expect(depositRepository.query).toHaveBeenCalledWith(
        'UPDATE `card_deposit` SET `status_checked_at` = ?, `updated_at` = `updated_at` WHERE `id` IN (?)',
        [ANY_DATE, '1'],
      );
    });

    it('stamps a deposit whose examination failed', async () => {
      const adapter = seed(settled());
      adapter.getCardDepositResult.mockRejectedValue(new Error('their outage'));

      await useCase.execute();

      expect(depositRepository.query).toHaveBeenCalled();
    });
  });

  describe('recording an outcome', () => {
    it('records what the issuer credited, on the status it reported', async () => {
      seed(settled());

      await useCase.execute();

      expect(depositRepository.update).toHaveBeenCalledWith(
        // Conditional on the status this pass read, so anything that moved the
        // deposit since the batch was loaded wins instead of being overwritten.
        { id: '1', status: CardDepositStatus.SUBMITTED },
        expect.objectContaining({
          status: CardDepositStatus.SETTLED,
          creditedAmount: '10',
          responsePayload: { status: 1 },
        }),
      );
    });

    it('writes nothing when their status has not moved', async () => {
      // What keeps this from rewriting every outstanding deposit on every tick.
      seed({ state: 'PENDING', rawPayload: { status: 0 } });

      await useCase.execute();

      expect(depositRepository.update).not.toHaveBeenCalled();
      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
    });

    it('writes nothing when they report the same status and the same detail', async () => {
      seed(
        { state: 'FAILED', reason: 'declined', rawPayload: {} },
        {
          status: CardDepositStatus.FAILED,
          message: 'declined',
        },
      );

      await useCase.execute();

      expect(depositRepository.update).not.toHaveBeenCalled();
    });

    it('records a failure reason that changed while the status did not', async () => {
      // Their status and the detail hanging off it do not move in lockstep, so
      // a pass keyed on the status alone would leave a partner reading a stale
      // explanation of why their money did not arrive.
      seed(
        { state: 'FAILED', reason: 'Exchange rate expired', rawPayload: {} },
        { status: CardDepositStatus.FAILED, message: 'declined' },
      );

      await useCase.execute();

      expect(depositRepository.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ message: 'Exchange rate expired' }),
      );
      // Not announced: the partner was already told this deposit failed, and a
      // second event carrying the same status says nothing new.
      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
    });

    it('records an identifier that arrived after the status settled there', async () => {
      // The empty-payload acceptance branch leaves the row without one, so a
      // later answer is the only place it can arrive.
      seed(
        {
          state: 'FAILED',
          reason: 'declined',
          providerDepositId: THEIR_DEPOSIT_ID,
          rawPayload: {},
        },
        {
          status: CardDepositStatus.FAILED,
          message: 'declined',
          providerDepositId: null,
        },
      );

      await useCase.execute();

      expect(depositRepository.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ providerDepositId: THEIR_DEPOSIT_ID }),
      );
    });

    it('records their failure reason and clears it again on the refund', async () => {
      seed({ state: 'FAILED', reason: 'Insufficient balance', rawPayload: {} });

      await useCase.execute();

      expect(depositRepository.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: CardDepositStatus.FAILED,
          message: 'Insufficient balance',
        }),
      );

      // Written as an explicit null rather than left undefined: TypeORM skips
      // an undefined column, so a reason left over from the failure would
      // otherwise survive onto the refund that cleared it.
      depositRepository.update.mockClear();
      seed(
        { state: 'REFUNDED', rawPayload: {} },
        {
          status: CardDepositStatus.FAILED,
        },
      );

      await useCase.execute();

      expect(depositRepository.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: CardDepositStatus.REFUNDED,
          reasonCode: null,
          message: null,
        }),
      );
    });

    it('truncates their reason to the column that holds it', async () => {
      seed({ state: 'FAILED', reason: 'x'.repeat(400), rawPayload: {} });

      await useCase.execute();

      expect(writtenColumns().message).toHaveLength(255);
    });

    it('fills in the issuer deposit id when the row has none', async () => {
      seed(settled(), { providerDepositId: null });

      await useCase.execute();

      expect(depositRepository.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ providerDepositId: THEIR_DEPOSIT_ID }),
      );
    });

    it('never overwrites an issuer deposit id the row already carries', async () => {
      seed(settled());

      await useCase.execute();

      expect(writtenColumns()).not.toHaveProperty('providerDepositId');
    });

    it('leaves a deposit alone when their id disagrees with the stored one', async () => {
      // Their answer names a different deposit than the one this reference
      // produced. Recording a settlement read off some other deposit is worse
      // than recording nothing, and it is not a disagreement this pass can
      // settle.
      seed(settled({ providerDepositId: 'a-different-order' }));

      await useCase.execute();

      expect(depositRepository.update).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    });

    it('settles without an amount when they credited a different currency', async () => {
      // A credited amount in the wrong currency is worse than none: their
      // status is still a fact about settlement, and the amount is a separate
      // fact this declines to record in a unit it cannot trust.
      seed(settled({ creditedCurrencyCode: 'eur' }));

      await useCase.execute();

      const changes = writtenColumns();
      expect(changes).toMatchObject({ status: CardDepositStatus.SETTLED });
      expect(changes).not.toHaveProperty('creditedAmount');
      expect(warnSpy).toHaveBeenCalled();
    });

    it('takes them at their word when they report no currency', async () => {
      const outcome = settled();
      delete (outcome as { creditedCurrencyCode?: string })
        .creditedCurrencyCode;
      seed(outcome);

      await useCase.execute();

      expect(depositRepository.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ creditedAmount: '10' }),
      );
    });

    it('says nothing further when another writer got there first', async () => {
      seed(settled());
      depositRepository.update.mockResolvedValue({ affected: 0 });

      await useCase.execute();

      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    });

    it('never writes the card balance', async () => {
      // The balance reconcile owns that column. Two writers disagreeing about
      // what one column means is how a balance starts flickering, and a balance
      // moves for spending and fees as well as for deposits — so it can neither
      // confirm nor contradict what became of any particular one.
      seed(settled());

      await useCase.execute();

      // Asserted against stubs that exist, so a write really would be recorded
      // here. Against a double lacking these methods the call would be a
      // TypeError swallowed by the per-row catch, and this would pass anyway.
      expect(cardRepository.update).not.toHaveBeenCalled();
      expect(cardRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('what the issuer cannot answer for', () => {
    it('leaves a reference the issuer denies exactly as it was', async () => {
      // This row says they accepted the deposit and they are now saying they
      // have never heard of it. Marking it failed on their word alone would
      // discard our own evidence that the call succeeded, on money that may
      // well have moved.
      seed({ state: 'UNKNOWN_REFERENCE' });

      await useCase.execute();

      expect(depositRepository.update).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    });

    it('skips a deposit whose card has no issuer card id', async () => {
      // Their lookup is keyed on the card as well as on our reference, and
      // inventing either half would ask about somebody else's deposit.
      const adapter = seed(settled(), {}, { providerCardId: null });

      await useCase.execute();

      expect(adapter.getCardDepositResult).not.toHaveBeenCalled();
      expect(depositRepository.update).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    });

    it("does not let one deposit's failure abort the pass", async () => {
      depositRepository.findAndCount.mockResolvedValue([
        [deposit({ id: '1' }), deposit({ id: '2', publicId: 'second' })],
        2,
      ]);
      cardRepository.find.mockResolvedValue([card()]);
      const adapter = issuerDouble();
      adapter.getCardDepositResult
        .mockRejectedValueOnce(new Error('their outage'))
        .mockResolvedValueOnce(settled());
      cardIssuerRegistry.resolve.mockReturnValue(adapter);

      await useCase.execute();

      expect(adapter.getCardDepositResult).toHaveBeenCalledTimes(2);
      expect(depositRepository.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('telling the partner', () => {
    it('announces a settlement once, after the write', async () => {
      seed(settled());

      await useCase.execute();

      expect(webhookDeliveryService.enqueueForCard).toHaveBeenCalledTimes(1);
      expect(webhookDeliveryService.enqueueForCard).toHaveBeenCalledWith(
        '10',
        '99',
        'card_deposit.status_updated',
        expect.objectContaining({
          eventType: 'card_deposit.status_updated',
          cardPublicId: 'card-public-id',
          depositPublicId: DEPOSIT_PUBLIC_ID,
          // Their own key, so a partner can match this against the request they
          // made without holding an identifier of ours.
          requestId: 'partner-key-1',
          status: CardDepositStatus.SETTLED,
        }),
      );
    });

    it('announces a failure too, because their failure is not terminal', async () => {
      // A deposit that fails and is never refunded has no terminal state to
      // announce, so notifying only on terminal outcomes would leave the
      // partner whose money did not arrive told nothing at all.
      seed({ state: 'FAILED', reason: 'declined', rawPayload: {} });

      await useCase.execute();

      expect(webhookDeliveryService.enqueueForCard).toHaveBeenCalledWith(
        '10',
        '99',
        'card_deposit.status_updated',
        expect.objectContaining({ status: CardDepositStatus.FAILED }),
      );
    });

    it('records the settlement even when the partner cannot be notified', async () => {
      // By the time the notification runs the read has succeeded and the row has
      // moved, so a failure here is ours rather than the issuer's — it must not
      // be reported as a failed settlement lookup or counted as unexamined.
      seed(settled());
      webhookDeliveryService.enqueueForCard.mockRejectedValueOnce(
        new Error('webhook_delivery insert failed'),
      );

      await expect(useCase.execute()).resolves.toBeUndefined();

      expect(depositRepository.update).toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Could not read the settlement'),
      );
    });

    it('uses one event type for every outcome', async () => {
      // Settling, failing and later being refunded are three states of one
      // deposit. A type per outcome means a new type the day a fifth status
      // starts mattering.
      for (const outcome of [
        settled(),
        { state: 'FAILED' as const, rawPayload: {} },
        { state: 'REFUND_PENDING' as const, rawPayload: {} },
        { state: 'REFUNDED' as const, rawPayload: {} },
      ]) {
        seed(outcome);
        await useCase.execute();
      }

      expect(webhookDeliveryService.enqueueForCard).toHaveBeenCalledTimes(4);
      for (let call = 1; call <= 4; call += 1) {
        expect(webhookDeliveryService.enqueueForCard).toHaveBeenNthCalledWith(
          call,
          '10',
          '99',
          'card_deposit.status_updated',
          expect.anything(),
        );
      }
    });
  });
  describe('resolving one deposit an issuer has named', () => {
    /** The reference the issuer echoes, never the partner's own key. */
    const resolveOne = (
      reference = DEPOSIT_PUBLIC_ID,
    ): Promise<CardCallbackResolution> =>
      useCase.resolveOneByProviderReference(
        CardProviderKey.HYPERCARD,
        reference,
      );

    it('selects on the reference the deposit was submitted under', async () => {
      depositRepository.findOne.mockResolvedValue(deposit());
      cardRepository.find.mockResolvedValue([card()]);
      cardIssuerRegistry.resolve.mockReturnValue(issuerDouble(settled()));

      await resolveOne();

      const [options] = callArguments(depositRepository.findOne);
      const where = (options as { where: Record<string, unknown> }).where;
      expect(where.providerReference).toBe(DEPOSIT_PUBLIC_ID);
      expect(where.providerKey).toBe(CardProviderKey.HYPERCARD);
      // Never sent to the issuer, so it cannot be what one echoes back.
      expect(where.requestId).toBeUndefined();
    });

    it('selects on the same outstanding statuses the pass does', async () => {
      depositRepository.findOne.mockResolvedValue(deposit());
      cardRepository.find.mockResolvedValue([card()]);
      cardIssuerRegistry.resolve.mockReturnValue(issuerDouble(settled()));

      await resolveOne();

      const [options] = callArguments(depositRepository.findOne);
      const statuses = (
        options as { where: { status: { value: CardDepositStatus[] } } }
      ).where.status.value;
      expect(statuses).toContain(CardDepositStatus.SUBMITTED);
      expect(statuses).not.toContain(CardDepositStatus.SETTLED);
    });

    it('asks the issuer and settles the deposit, as the pass would', async () => {
      depositRepository.findOne.mockResolvedValue(deposit());
      cardRepository.find.mockResolvedValue([card()]);
      const adapter = issuerDouble(settled());
      cardIssuerRegistry.resolve.mockReturnValue(adapter);

      await expect(resolveOne()).resolves.toBe('RESOLVED');

      expect(adapter.getCardDepositResult).toHaveBeenCalledWith(
        PROVIDER_CARD_ID,
        DEPOSIT_PUBLIC_ID,
        {},
      );
      expect(writtenColumns()).toMatchObject({
        status: CardDepositStatus.SETTLED,
      });
      expect(webhookDeliveryService.enqueueForCard).toHaveBeenCalled();
    });

    it('takes the rotation stamp, so the row does not hold the head of every later pass', async () => {
      depositRepository.findOne.mockResolvedValue(deposit());
      cardRepository.find.mockResolvedValue([card()]);
      cardIssuerRegistry.resolve.mockReturnValue(
        issuerDouble({ state: 'PENDING', rawPayload: {} }),
      );

      await resolveOne();

      expect(depositRepository.query).toHaveBeenCalledWith(
        expect.stringContaining('status_checked_at'),
        expect.arrayContaining([ANY_DATE, '1']) as unknown[],
      );
    });

    it('answers that nothing was resolved when no row is outstanding', async () => {
      depositRepository.findOne.mockResolvedValue(null);

      await expect(resolveOne('an-outsider')).resolves.toBe('NO_ROW');
      expect(cardIssuerRegistry.resolve).not.toHaveBeenCalled();
    });

    it('never asks a provider that takes no deposits', async () => {
      cardIssuerRegistry.keysWithCapability.mockReturnValue([]);

      await expect(resolveOne()).resolves.toBe('NO_ROW');
      expect(depositRepository.findOne).not.toHaveBeenCalled();
    });

    it('says so rather than asking when the card carries no issuer id', async () => {
      depositRepository.findOne.mockResolvedValue(deposit());
      cardRepository.find.mockResolvedValue([card({ providerCardId: null })]);

      await expect(resolveOne()).resolves.toBe('UNRESOLVABLE');
      expect(cardIssuerRegistry.resolve).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('no issuer card id'),
      );
    });
  });
});
