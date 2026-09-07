import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CardCapability } from '../domain/card-capability.enum';
import { CardIssuerPort } from '../domain/card-issuer.port';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { ReconcileCardBalancesUseCase } from './reconcile-card-balances.usecase';

describe('ReconcileCardBalancesUseCase', () => {
  let useCase: ReconcileCardBalancesUseCase;
  let cardRepository: {
    find: jest.Mock;
    findAndCount: jest.Mock;
    update: jest.Mock;
    save: jest.Mock;
    query: jest.Mock;
  };
  let cardIssuerRegistry: { resolve: jest.Mock };
  let configService: { getOrThrow: jest.Mock };
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  const BATCH_SIZE = 25;

  const baseCard: Partial<CardEntity> = {
    id: '1',
    publicId: 'card-public-id',
    providerKey: CardProviderKey.AXYS,
    providerCardId: 'axys-card-id',
    balanceAvailable: null,
    balanceLedger: null,
    balanceCurrency: null,
  };

  /** Their answer, in the representation these columns hold. */
  const theirBalance = {
    available: '100.00',
    ledger: '100.00',
    currencyCode: 'USD',
    observedAt: '2026-08-15T00:00:00.000Z',
  };

  // Typed against the port so the double cannot drift from the interface it
  // stands in for.
  type IssuerDouble = Pick<CardIssuerPort, 'capabilities'> & {
    getCardBalance: jest.Mock;
  };

  const issuerDouble = (
    capabilities: CardCapability[],
    getCardBalance = jest.fn(),
  ): IssuerDouble => ({
    capabilities: new Set(capabilities),
    getCardBalance,
  });

  /**
   * The options the pass queried with. Read off the call and typed here rather
   * than compared against an `expect.objectContaining`, which returns `any`
   * and takes the assertion's type checking with it.
   */
  const loadOptions = () => {
    const [options] = cardRepository.find.mock.calls[0] as [
      {
        where: { status: CardStatus; providerCardId: unknown };
        order: unknown;
        take: number;
      },
    ];
    return options;
  };

  /** One batch of cards for the pass to examine. */
  const returns = (cards: Partial<CardEntity>[]) =>
    cardRepository.find.mockResolvedValueOnce(cards);

  beforeEach(async () => {
    cardRepository = {
      find: jest.fn(),
      // Present and never expected to be called: `findAndCount` would answer
      // the saturation question with an aggregate over every active card on
      // every tick, on the one pass whose set never drains.
      findAndCount: jest.fn(),
      update: jest.fn(),
      // Present and asserted-on rather than absent: a double missing the method
      // would make a stray `save` throw a TypeError the per-card catch
      // swallows, so a "never saves" assertion would pass either way.
      save: jest.fn(),
      query: jest.fn(),
    };
    cardIssuerRegistry = { resolve: jest.fn() };
    configService = { getOrThrow: jest.fn().mockReturnValue(BATCH_SIZE) };

    // execute() swallows every per-card error into logger.warn, so without this
    // spy a crash inside reconcileOne is indistinguishable from a clean skip
    // and the negative assertions below would pass vacuously.
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReconcileCardBalancesUseCase,
        { provide: getRepositoryToken(CardEntity), useValue: cardRepository },
        { provide: CardIssuerRegistry, useValue: cardIssuerRegistry },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    useCase = module.get(ReconcileCardBalancesUseCase);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('the selection', () => {
    it('takes a bounded batch of active cards, least-recently-checked first', async () => {
      returns([]);

      await useCase.execute();

      expect(configService.getOrThrow).toHaveBeenCalledWith(
        'CARD_BALANCE_SWEEP_BATCH_SIZE',
      );

      const options = loadOptions();
      expect(options.where.status).toBe(CardStatus.ACTIVE);
      // An active card stays active, so this set never drains — the ordering is
      // what stops a bounded pass re-reading the same head of the queue for
      // ever while newer cards behind it are never reached.
      expect(options.order).toEqual({ statusCheckedAt: 'ASC', id: 'ASC' });
      expect(options.take).toBe(BATCH_SIZE);
    });

    it('excludes a card with no provider card id in the query', async () => {
      returns([]);

      await useCase.execute();

      // Filtered rather than skipped in the loop: such a card cannot be asked
      // about at all, so letting one into the batch spends a slot a readable
      // card would use.
      expect(loadOptions().where.providerCardId).toBeDefined();
    });

    it('does nothing at all when no card is waiting', async () => {
      returns([]);

      await useCase.execute();

      expect(cardRepository.query).not.toHaveBeenCalled();
      expect(cardIssuerRegistry.resolve).not.toHaveBeenCalled();
    });

    it('does not count the whole active set to describe the batch', async () => {
      // The saturation signal is derived from the batch — whether it came back
      // full, and how old its head is — rather than from an aggregate whose cost
      // grows with the estate for ever. This pass's selection never drains, so
      // that aggregate is the one query here that could not be bounded.
      returns([{ ...baseCard }]);
      cardIssuerRegistry.resolve.mockReturnValueOnce(
        issuerDouble([CardCapability.BALANCE_READ]),
      );

      await useCase.execute();

      expect(cardRepository.findAndCount).not.toHaveBeenCalled();
    });

    it('reports a full batch as behind, with how far back it reached', async () => {
      const full = Array.from({ length: BATCH_SIZE }, (_unused, index) => ({
        ...baseCard,
        id: String(index + 1),
        statusCheckedAt: new Date(Date.now() - 90 * 60_000),
      }));
      returns(full);
      cardIssuerRegistry.resolve.mockReturnValue(
        issuerDouble([CardCapability.BALANCE_READ]),
      );

      await useCase.execute();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('batch full'),
      );
      // Ninety minutes, from the head of the batch — the figure that says how
      // far back the rotation had to reach.
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('90m ago'));
    });

    it('reports a partial batch as the whole set covered', async () => {
      // The other half of the saturation signal, and the reason it is worth
      // having at all: at the ceiling a queue hours behind would otherwise log
      // exactly what a queue fully covered logs.
      returns([{ ...baseCard }]);
      cardIssuerRegistry.resolve.mockReturnValueOnce(
        issuerDouble([CardCapability.BALANCE_READ]),
      );

      await useCase.execute();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('whole set covered'),
      );
    });

    it('names a full batch still holding cards never asked about', async () => {
      // A never-stamped card sorts first, so a full batch containing one is
      // behind by definition — and there is no elapsed time to report for it.
      const full = Array.from({ length: BATCH_SIZE }, (_unused, index) => ({
        ...baseCard,
        id: String(index + 1),
        statusCheckedAt: null,
      }));
      returns(full);
      cardIssuerRegistry.resolve.mockReturnValue(
        issuerDouble([CardCapability.BALANCE_READ]),
      );

      await useCase.execute();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('not yet asked about'),
      );
    });
  });

  describe('the rotation stamp', () => {
    it('stamps the whole batch before any card is examined', async () => {
      const order: string[] = [];
      cardRepository.query.mockImplementationOnce(() => {
        order.push('stamp');
        return Promise.resolve(undefined);
      });
      returns([{ ...baseCard }]);
      cardIssuerRegistry.resolve.mockReturnValueOnce(
        issuerDouble(
          [CardCapability.BALANCE_READ],
          jest.fn().mockImplementationOnce(() => {
            order.push('read');
            return Promise.resolve(theirBalance);
          }),
        ),
      );

      await useCase.execute();

      // The stamp records that the pass looked, not that the look succeeded —
      // a card an issuer keeps failing to answer for has to rotate to the back
      // like any other, or one unreachable card starves the queue behind it.
      expect(order).toEqual(['stamp', 'read']);
    });

    it('pins updated_at to itself so the column keeps its meaning', async () => {
      returns([{ ...baseCard }]);
      cardIssuerRegistry.resolve.mockReturnValueOnce(
        issuerDouble([CardCapability.BALANCE_READ]),
      );

      await useCase.execute();

      // Both halves are needed and only the second is easy to lose: TypeORM
      // cannot write one column alone, and `updated_at` is additionally
      // ON UPDATE CURRENT_TIMESTAMP(6) in the migration, which fires whatever
      // the SET list names.
      const [sql] = cardRepository.query.mock.calls[0] as [string];
      expect(sql).toContain('`status_checked_at` = ?');
      expect(sql).toContain('`updated_at` = `updated_at`');
    });

    it('still stamps a card whose read then failed', async () => {
      returns([{ ...baseCard }]);
      cardIssuerRegistry.resolve.mockReturnValueOnce(
        issuerDouble(
          [CardCapability.BALANCE_READ],
          jest.fn().mockRejectedValueOnce(new Error('Card no existed')),
        ),
      );

      await useCase.execute();

      expect(cardRepository.query).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('card-public-id'),
      );
    });
  });

  describe('what a reading writes', () => {
    it('persists a balance for a provider that declares BALANCE_READ', async () => {
      returns([{ ...baseCard }]);
      const double = issuerDouble(
        [CardCapability.BALANCE_READ],
        jest.fn().mockResolvedValueOnce(theirBalance),
      );
      cardIssuerRegistry.resolve.mockReturnValueOnce(double);

      await useCase.execute();

      expect(double.getCardBalance).toHaveBeenCalledWith('axys-card-id', {});
      expect(cardRepository.update).toHaveBeenCalledWith('1', {
        balanceAvailable: '100.00',
        balanceLedger: '100.00',
        balanceCurrency: 'USD',
        // The one type-converting line in the pass: a malformed timestamp
        // would otherwise persist as Invalid Date unnoticed.
        balanceObservedAt: new Date('2026-08-15T00:00:00.000Z'),
      });
      // `update`, never `save` — the entity is deliberately partially loaded,
      // and saving one would write nulls over the columns the select omitted.
      expect(cardRepository.save).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('writes nothing when the figures have not moved', async () => {
      returns([
        {
          ...baseCard,
          balanceAvailable: '100.00',
          balanceLedger: '100.00',
          balanceCurrency: 'USD',
        },
      ]);
      cardIssuerRegistry.resolve.mockReturnValueOnce(
        issuerDouble(
          [CardCapability.BALANCE_READ],
          jest.fn().mockResolvedValueOnce({
            ...theirBalance,
            // Later than whatever is stored, which is the ordinary case for an
            // issuer publishing no timestamp of its own — the observation time
            // moves on every pass and must not by itself rewrite the row.
            observedAt: '2026-08-16T00:00:00.000Z',
          }),
        ),
      );

      await useCase.execute();

      expect(cardRepository.update).not.toHaveBeenCalled();
    });

    it('writes when only the currency changed', async () => {
      returns([
        {
          ...baseCard,
          balanceAvailable: '100.00',
          balanceLedger: '100.00',
          balanceCurrency: 'EUR',
        },
      ]);
      cardIssuerRegistry.resolve.mockReturnValueOnce(
        issuerDouble(
          [CardCapability.BALANCE_READ],
          jest.fn().mockResolvedValueOnce(theirBalance),
        ),
      );

      await useCase.execute();

      expect(cardRepository.update).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({ balanceCurrency: 'USD' }),
      );
    });

    it('leaves the row alone when an issuer reports no balance yet', async () => {
      // One issuer answers null while a card is not yet in a balance-bearing
      // state. That is an answer rather than a failure, so nothing is written
      // and nothing is warned about.
      returns([{ ...baseCard }]);
      cardIssuerRegistry.resolve.mockReturnValueOnce(
        issuerDouble(
          [CardCapability.BALANCE_READ],
          jest.fn().mockResolvedValueOnce(null),
        ),
      );

      await useCase.execute();

      expect(cardRepository.update).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('carries the amount across as the string the issuer published', async () => {
      // The representation these columns hold, pinned at the layer that writes
      // them: a decimal string in the currency's own units, never converted.
      returns([{ ...baseCard }]);
      cardIssuerRegistry.resolve.mockReturnValueOnce(
        issuerDouble(
          [CardCapability.BALANCE_READ],
          jest
            .fn()
            .mockResolvedValueOnce({ ...theirBalance, available: '10.00' }),
        ),
      );

      await useCase.execute();

      expect(cardRepository.update).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({ balanceAvailable: '10.00' }),
      );
    });
  });

  describe('capabilities and isolation', () => {
    it('skips a provider that declares only DEPOSIT_ADDRESS', async () => {
      returns([{ ...baseCard }]);
      const double = issuerDouble([CardCapability.DEPOSIT_ADDRESS]);
      cardIssuerRegistry.resolve.mockReturnValueOnce(double);

      await useCase.execute();

      expect(double.getCardBalance).not.toHaveBeenCalled();
      expect(cardRepository.update).not.toHaveBeenCalled();
      // Proves the skip was the capability gate, not a swallowed exception.
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('skips a provider that declares no capabilities at all', async () => {
      // The shape a scaffolded adapter ships in before its first feature story.
      returns([{ ...baseCard }]);
      const double = issuerDouble([]);
      cardIssuerRegistry.resolve.mockReturnValueOnce(double);

      await useCase.execute();

      expect(double.getCardBalance).not.toHaveBeenCalled();
      expect(cardRepository.update).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('skips an active card whose provider card id is empty', async () => {
      // The query excludes NULL and cannot exclude `''`, which the column
      // permits — and every other guard on this value in the codebase tests it
      // for falsiness. Without this the issuer would be asked for card "".
      returns([{ ...baseCard, providerCardId: '' }]);
      const double = issuerDouble([CardCapability.BALANCE_READ]);
      cardIssuerRegistry.resolve.mockReturnValueOnce(double);

      await useCase.execute();

      expect(double.getCardBalance).not.toHaveBeenCalled();
      expect(cardRepository.update).not.toHaveBeenCalled();
      // Warned rather than silent: such a row is a data defect worth surfacing,
      // and it is stamped like any other so it does not hold the queue.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('empty provider card id'),
      );
    });

    it('keeps going after one card fails', async () => {
      returns([
        { ...baseCard },
        { ...baseCard, id: '2', publicId: 'second-card' },
      ]);
      const failing = issuerDouble(
        [CardCapability.BALANCE_READ],
        jest.fn().mockRejectedValueOnce(new Error('Card no existed')),
      );
      const working = issuerDouble(
        [CardCapability.BALANCE_READ],
        jest.fn().mockResolvedValueOnce(theirBalance),
      );
      cardIssuerRegistry.resolve
        .mockReturnValueOnce(failing)
        .mockReturnValueOnce(working);

      await useCase.execute();

      expect(cardRepository.update).toHaveBeenCalledWith(
        '2',
        expect.objectContaining({ balanceAvailable: '100.00' }),
      );
    });
  });
});
