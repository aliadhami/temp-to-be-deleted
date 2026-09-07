import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError } from 'typeorm';
import { CardCapability } from '../domain/card-capability.enum';
import { CardIssuerPort, CardProductListing } from '../domain/card-issuer.port';
import { CardOrganisation } from '../domain/card-organisation.enum';
import { CardLifecycleOperation } from '../domain/card-lifecycle-operation.enum';
import { CardProduct } from '../domain/card-product.model';
import { CardProductActivationMode } from '../domain/card-product-activation-mode.enum';
import { CardProductSensitiveDetailMode } from '../domain/card-product-sensitive-detail-mode.enum';
import { CardProductApplicationMode } from '../domain/card-product-application-mode.enum';
import { CardProviderCatalogueNotStoredError } from '../domain/card-provider-catalogue-not-stored.error';
import { CardProviderCatalogueUnavailableError } from '../domain/card-provider-catalogue-unavailable.error';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardType } from '../domain/card-type.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { SyncCardProductsUseCase } from './sync-card-products.usecase';

/** What one `INSERT … ON DUPLICATE KEY UPDATE` was asked to do. */
interface RecordedInsert {
  values: Record<string, unknown>[];
  overwrite: string[];
}

/** What one `UPDATE` was asked to do. */
interface RecordedUpdate {
  set: Record<string, unknown>;
  conditions: string[];
  parameters: Record<string, unknown>;
}

describe('SyncCardProductsUseCase', () => {
  let useCase: SyncCardProductsUseCase;
  let dataSource: { transaction: jest.Mock; getRepository: jest.Mock };
  let cardIssuerRegistry: { resolve: jest.Mock };

  /** The statements the write phase issued, in the order it issued them. */
  let inserts: RecordedInsert[];
  let updates: RecordedUpdate[];

  /** The same sequence reduced to labels, with the commit marked. */
  let statements: string[];

  /** Every statement's result, so a case can make one of them fail. */
  let executeInsert: jest.Mock<Promise<unknown>, []>;
  let executeUpdate: jest.Mock<Promise<{ affected: number }>, []>;
  /** How many of this run's minted `public_id`s landed on a row. */
  let countInserted: jest.Mock<Promise<number>, []>;

  // Typed against the port so the double cannot drift from the interface it
  // stands in for.
  type IssuerDouble = Pick<CardIssuerPort, 'capabilities'> & {
    listCardProducts: jest.Mock;
  };

  const issuerDouble = (
    capabilities: CardCapability[],
    listCardProducts = jest.fn(),
  ): IssuerDouble => ({
    capabilities: new Set(capabilities),
    listCardProducts,
  });

  const baseProduct = (overrides: Partial<CardProduct> = {}): CardProduct => ({
    providerProductId: 'hc-1',
    displayName: 'Mastercard Virtual USD',
    cardType: CardType.VIRTUAL,
    cardOrganisation: CardOrganisation.MASTERCARD,
    material: null,
    currencyCode: 'USD',
    fees: {
      issuance: { amount: '20', currencyCode: 'USDT' },
      annual: null,
      depositFeePercent: '1.500',
    },
    depositLimits: {
      minPerTransaction: '10',
      maxPerTransaction: '100000',
      maxPerDay: '1000000',
      requiresInitialDeposit: true,
      minInitialDeposit: '10',
    },
    applicationMode: CardProductApplicationMode.NO_KYC,
    requiresKyc: false,
    activation: {
      mode: CardProductActivationMode.ISSUER_REQUEST,
      requiresIdentityDocument: true,
    },
    sensitiveDetailMode: CardProductSensitiveDetailMode.API,
    availableForIssuance: true,
    supportedOperations: [
      CardLifecycleOperation.BLOCK,
      CardLifecycleOperation.UNBLOCK,
    ],
    ...overrides,
  });

  const baseListing = (
    overrides: Partial<CardProduct> = {},
    rawPayload: Record<string, unknown> = { card_type_id: '52400002' },
  ): CardProductListing =>
    ({
      product: baseProduct(overrides),
      rawPayload,
    }) satisfies CardProductListing;

  /** Resolves a provider that offers `listings` and declares the capability. */
  const catalogueOf = (listings: CardProductListing[]): IssuerDouble => {
    const double = issuerDouble(
      [CardCapability.PRODUCT_CATALOGUE],
      jest.fn().mockResolvedValueOnce(listings),
    );
    cardIssuerRegistry.resolve.mockReturnValueOnce(double);
    return double;
  };

  /** A failure as the driver reports it. */
  const queryFailure = (code: string): Error => {
    const error = Object.create(QueryFailedError.prototype) as Error;
    Object.assign(error, { code, message: `driver reported ${code}` });
    return error;
  };

  beforeEach(async () => {
    inserts = [];
    updates = [];
    statements = [];
    executeInsert = jest.fn<Promise<unknown>, []>().mockResolvedValue({});
    executeUpdate = jest
      .fn<Promise<{ affected: number }>, []>()
      .mockResolvedValue({ affected: 0 });
    countInserted = jest.fn<Promise<number>, []>().mockResolvedValue(0);

    const insertBuilder = (): Record<string, unknown> => {
      const recorded: RecordedInsert = { values: [], overwrite: [] };
      const builder = {
        into: () => builder,
        values: (rows: Record<string, unknown>[]) => {
          recorded.values = rows;
          return builder;
        },
        orUpdate: (overwrite: string[]) => {
          recorded.overwrite = overwrite;
          return builder;
        },
        execute: () => {
          inserts.push(recorded);
          statements.push('insert');
          return executeInsert();
        },
      };
      return builder;
    };

    const updateBuilder = (): Record<string, unknown> => {
      const recorded: RecordedUpdate = {
        set: {},
        conditions: [],
        parameters: {},
      };
      const clause = (
        condition: string,
        parameters?: Record<string, unknown>,
      ): Record<string, unknown> => {
        recorded.conditions.push(condition);
        Object.assign(recorded.parameters, parameters ?? {});
        return builder;
      };
      const builder = {
        set: (values: Record<string, unknown>) => {
          recorded.set = values;
          return builder;
        },
        where: clause,
        andWhere: clause,
        execute: () => {
          updates.push(recorded);
          statements.push('update');
          return executeUpdate();
        },
      };
      return builder;
    };

    // The use case does all its writing inside one transaction, through query
    // builders and never the repository: the transaction must contain no
    // `SELECT`, or the withdrawal starts meeting rows the server refuses to
    // let it write.
    const manager = {
      createQueryBuilder: () => ({
        insert: insertBuilder,
        update: updateBuilder,
      }),
    } as unknown as EntityManager;
    dataSource = {
      transaction: jest.fn(
        async (run: (m: EntityManager) => Promise<unknown>) => {
          const result = await run(manager);
          statements.push('commit');
          return result;
        },
      ),
      getRepository: jest.fn(() => ({
        count: () => {
          statements.push('count');
          return countInserted();
        },
      })),
    };
    cardIssuerRegistry = { resolve: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncCardProductsUseCase,
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: CardIssuerRegistry, useValue: cardIssuerRegistry },
      ],
    }).compile();

    useCase = module.get(SyncCardProductsUseCase);
  });

  it('refuses a provider that does not declare PRODUCT_CATALOGUE', async () => {
    const double = issuerDouble([]);
    cardIssuerRegistry.resolve.mockReturnValueOnce(double);

    await expect(useCase.execute(CardProviderKey.AXYS)).rejects.toThrow(
      'Card provider "AXYS" does not support a product catalogue',
    );
    expect(double.listCardProducts).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('throws CardProviderCatalogueUnavailableError and writes nothing when the provider call fails', async () => {
    const double = issuerDouble(
      [CardCapability.PRODUCT_CATALOGUE],
      jest.fn().mockRejectedValueOnce(new Error('network down')),
    );
    cardIssuerRegistry.resolve.mockReturnValueOnce(double);

    await expect(
      useCase.execute(CardProviderKey.HYPERCARD),
    ).rejects.toBeInstanceOf(CardProviderCatalogueUnavailableError);
    // The failure happens before the write phase opens at all — the previous
    // snapshot is untouched by construction.
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('writes every row inside one transaction', async () => {
    // A failure partway through must not leave some rows carrying the new
    // synced_at and the rest stale, which would read as a fresh snapshot.
    catalogueOf([baseListing()]);

    await useCase.execute(CardProviderKey.HYPERCARD);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(1);
  });

  it('upserts one row per listing, each carrying a freshly minted public_id', async () => {
    const listing = baseListing();
    catalogueOf([listing]);
    countInserted.mockResolvedValueOnce(1);

    const result = await useCase.execute(CardProviderKey.HYPERCARD);

    expect(result).toMatchObject({
      providerKey: CardProviderKey.HYPERCARD,
      received: 1,
      created: 1,
      updated: 0,
      markedUnavailable: 0,
    });
    expect(inserts[0]?.values).toEqual([
      expect.objectContaining({
        providerKey: CardProviderKey.HYPERCARD,
        providerProductId: 'hc-1',
        displayName: 'Mastercard Virtual USD',
        supportedOperations: [
          CardLifecycleOperation.BLOCK,
          CardLifecycleOperation.UNBLOCK,
        ],
        rawPayload: listing.rawPayload,
        publicId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        ) as unknown as string,
      }),
    ]);
  });

  it('stores an empty operation list rather than nothing', async () => {
    catalogueOf([baseListing({ supportedOperations: [] })]);

    await useCase.execute(CardProviderKey.HYPERCARD);

    expect(inserts[0]?.values[0]).toMatchObject({ supportedOperations: [] });
  });

  it('writes without reading, and counts what it inserted only after the commit', async () => {
    // A `SELECT` joining this transaction brings the failure straight back: it
    // fixes the transaction's view of the table, and the withdrawal `UPDATE`
    // that follows is then refused for meeting a row a concurrent sync
    // committed in between.
    catalogueOf([baseListing()]);

    await useCase.execute(CardProviderKey.HYPERCARD);

    expect(statements).toEqual([
      'insert',
      'update',
      'update',
      'commit',
      'count',
    ]);
  });

  it('counts a row whose public_id did not land as an update, not a creation', async () => {
    // The row already existed — either from an earlier sync or from a
    // concurrent one that won the insert — so the id this run minted was
    // discarded and the stored one survived.
    catalogueOf([baseListing()]);
    countInserted.mockResolvedValueOnce(0);

    const result = await useCase.execute(CardProviderKey.HYPERCARD);

    expect(result).toMatchObject({ created: 0, updated: 1 });
  });

  it('never overwrites the columns that identify a row', async () => {
    // A wrong-index match would otherwise rewrite a product's identity, and a
    // loser's insert would stop being a harmless update.
    catalogueOf([baseListing()]);

    await useCase.execute(CardProviderKey.HYPERCARD);

    const overwritten = inserts[0]?.overwrite ?? [];
    expect(overwritten).not.toContain('public_id');
    expect(overwritten).not.toContain('provider_key');
    expect(overwritten).not.toContain('provider_product_id');
    expect(overwritten).not.toContain('id');
    expect(overwritten).not.toContain('created_at');
    // Everything the sync owns is overwritten, including the confirmation
    // timestamp that makes a repeat run mean something.
    expect(overwritten).toEqual(
      expect.arrayContaining([
        'display_name',
        'available_for_issuance',
        'raw_payload',
        'synced_at',
      ]),
    );
  });

  it('writes rows in natural-key order so two syncs take their locks in the same order', async () => {
    catalogueOf([
      baseListing({ providerProductId: 'hc-3' }),
      baseListing({ providerProductId: 'hc-1' }),
      baseListing({ providerProductId: 'hc-2' }),
    ]);

    await useCase.execute(CardProviderKey.HYPERCARD);

    expect(inserts[0]?.values.map((row) => row.providerProductId)).toEqual([
      'hc-1',
      'hc-2',
      'hc-3',
    ]);
  });

  it('keeps the first of a product repeated within one response', async () => {
    // Two tuples sharing a natural key would otherwise collide inside one
    // statement, and the counts would report a creation and an update for one
    // product.
    catalogueOf([
      baseListing({ displayName: 'First' }),
      baseListing({ displayName: 'Second' }),
    ]);
    countInserted.mockResolvedValueOnce(1);

    const result = await useCase.execute(CardProviderKey.HYPERCARD);

    expect(result).toMatchObject({ received: 2, created: 1, updated: 0 });
    expect(inserts[0]?.values).toHaveLength(1);
    expect(inserts[0]?.values[0]).toMatchObject({ displayName: 'First' });
  });

  it('withdraws absent products in two statements and reports only the ones still on offer', async () => {
    catalogueOf([baseListing()]);
    // The already-withdrawn pass first, then the flip whose affected count is
    // what a partner-facing sync reports as withdrawn.
    executeUpdate
      .mockResolvedValueOnce({ affected: 7 })
      .mockResolvedValueOnce({ affected: 2 });

    const result = await useCase.execute(CardProviderKey.HYPERCARD);

    expect(result.markedUnavailable).toBe(2);
    expect(updates).toHaveLength(2);

    const [confirmed, flipped] = updates;
    // Confirming a row that was already withdrawn moves nothing but the
    // timestamp — the staleness window keys off it.
    expect(confirmed?.set).toEqual({
      syncedAt: expect.any(Date) as unknown as Date,
    });
    expect(confirmed?.conditions).toContain('available_for_issuance = FALSE');
    expect(flipped?.set).toMatchObject({ availableForIssuance: false });
    expect(flipped?.conditions).toContain('available_for_issuance = TRUE');
    // Disjoint sets, so neither statement can count the other's rows.
    expect(confirmed?.conditions).not.toContain(
      'available_for_issuance = TRUE',
    );
  });

  it('withdraws the whole catalogue when the provider lists nothing, without an empty NOT IN', async () => {
    catalogueOf([]);
    executeUpdate
      .mockResolvedValueOnce({ affected: 0 })
      .mockResolvedValueOnce({ affected: 3 });

    const result = await useCase.execute(CardProviderKey.HYPERCARD);

    expect(result).toMatchObject({
      received: 0,
      created: 0,
      updated: 0,
      markedUnavailable: 3,
    });
    // Nothing to insert, and every row this provider owns is absent — so the
    // statements carry no product-id exclusion at all.
    expect(inserts).toHaveLength(0);
    expect(countInserted).not.toHaveBeenCalled();
    for (const update of updates) {
      expect(update.conditions).not.toContain(
        'provider_product_id NOT IN (:...seenProductIds)',
      );
    }
  });

  describe('when the write commits but the count that follows fails', () => {
    // The count stands outside the transaction, so its failure is not the
    // write's. Treating it as one would report a durable snapshot as lost and
    // re-run a write that already happened.

    it('still reports the sync as successful, with the counts unknown', async () => {
      catalogueOf([baseListing()]);
      executeUpdate
        .mockResolvedValueOnce({ affected: 0 })
        .mockResolvedValueOnce({ affected: 2 });
      countInserted.mockRejectedValueOnce(queryFailure('ER_LOCK_WAIT_TIMEOUT'));

      const result = await useCase.execute(CardProviderKey.HYPERCARD);

      expect(result.created).toBeNull();
      expect(result.updated).toBeNull();
      // The half that is known stays known — the write did withdraw two.
      expect(result.markedUnavailable).toBe(2);
      expect(result.syncedAt).toBeInstanceOf(Date);
    });

    it('does not re-run the write, which would lose the withdrawal count', async () => {
      // A repeat would find the rows already withdrawn, so the second
      // withdrawal `UPDATE` would match nothing and report zero products
      // withdrawn for a run that withdrew them.
      catalogueOf([baseListing()]);
      executeUpdate
        .mockResolvedValueOnce({ affected: 0 })
        .mockResolvedValueOnce({ affected: 3 })
        .mockResolvedValue({ affected: 0 });
      countInserted.mockRejectedValueOnce(queryFailure('ER_LOCK_DEADLOCK'));

      const result = await useCase.execute(CardProviderKey.HYPERCARD);

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(inserts).toHaveLength(1);
      expect(result.markedUnavailable).toBe(3);
    });

    it('does not report the snapshot as unstored', async () => {
      // The read path degrades on this error, so raising it here would hide a
      // catalogue that is on disk behind the previous snapshot for a minute.
      catalogueOf([baseListing()]);
      countInserted.mockRejectedValueOnce(queryFailure('ER_LOCK_DEADLOCK'));

      await expect(
        useCase.execute(CardProviderKey.HYPERCARD),
      ).resolves.toBeDefined();
    });
  });

  it('restarts the transaction when the server rolls the write back as a deadlock victim', async () => {
    // Losing repeatedly is ordinary rather than suspicious here: each deadlock
    // costs one transaction and lets another finish, so a sync racing several
    // peers can be chosen victim more than once and still be making progress.
    catalogueOf([baseListing()]);
    executeInsert
      .mockRejectedValueOnce(queryFailure('ER_LOCK_DEADLOCK'))
      .mockRejectedValueOnce(queryFailure('ER_LOCK_DEADLOCK'));
    countInserted.mockResolvedValueOnce(1);

    const result = await useCase.execute(CardProviderKey.HYPERCARD);

    expect(dataSource.transaction).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ created: 1, updated: 0 });
  });

  it('contains a deadlock that outlives the retry rather than letting it escape', async () => {
    // The read endpoint degrades on this error the same way it does on an
    // unreachable provider. Letting the raw query failure through is what used
    // to reach a partner as a server fault.
    catalogueOf([baseListing()]);
    executeInsert.mockRejectedValue(queryFailure('ER_LOCK_DEADLOCK'));

    await expect(
      useCase.execute(CardProviderKey.HYPERCARD),
    ).rejects.toBeInstanceOf(CardProviderCatalogueNotStoredError);
    expect(dataSource.transaction).toHaveBeenCalledTimes(5);
  });

  it('does not retry a database failure the server does not ask to be repeated', async () => {
    catalogueOf([baseListing()]);
    executeInsert.mockRejectedValue(queryFailure('ER_NO_SUCH_TABLE'));

    await expect(
      useCase.execute(CardProviderKey.HYPERCARD),
    ).rejects.toBeInstanceOf(CardProviderCatalogueNotStoredError);
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('lets a failure that is not the database’s escape unwrapped', async () => {
    // Dressing a bug of ours as a storage failure would report it to a partner
    // as a slightly stale catalogue and to us as nothing at all.
    catalogueOf([baseListing()]);
    const ourBug = new TypeError('rows.map is not a function');
    executeInsert.mockRejectedValue(ourBug);

    await expect(useCase.execute(CardProviderKey.HYPERCARD)).rejects.toBe(
      ourBug,
    );
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });
});
