import {
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CardCapability } from '../domain/card-capability.enum';
import { CardIssuerPort } from '../domain/card-issuer.port';
import { CardLifecycleOperation } from '../domain/card-lifecycle-operation.enum';
import { CardMaterial } from '../domain/card-material.enum';
import { CardOrganisation } from '../domain/card-organisation.enum';
import { CardProductActivationMode } from '../domain/card-product-activation-mode.enum';
import { CardProductSensitiveDetailMode } from '../domain/card-product-sensitive-detail-mode.enum';
import { CardProductApplicationMode } from '../domain/card-product-application-mode.enum';
import { CardProviderCatalogueNotStoredError } from '../domain/card-provider-catalogue-not-stored.error';
import { CardProviderCatalogueUnavailableError } from '../domain/card-provider-catalogue-unavailable.error';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardType } from '../domain/card-type.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardProductEntity } from '../infrastructure/persistence/card-product.entity';
import { ListCardProductsUseCase } from './list-card-products.usecase';
import { SyncCardProductsUseCase } from './sync-card-products.usecase';

const TTL_SECONDS = 3600;

describe('ListCardProductsUseCase', () => {
  let useCase: ListCardProductsUseCase;
  let repository: { find: jest.Mock };
  let cardIssuerRegistry: { resolve: jest.Mock };
  let syncCardProductsUseCase: { execute: jest.Mock };
  let configGetOrThrow: jest.Mock;

  // Typed against the port so the double cannot drift from the interface it
  // stands in for.
  type IssuerDouble = Pick<CardIssuerPort, 'capabilities'>;

  const issuerDouble = (capabilities: CardCapability[]): IssuerDouble => ({
    capabilities: new Set(capabilities),
  });

  const secondsAgo = (seconds: number): Date =>
    new Date(Date.now() - seconds * 1000);

  /**
   * Modelled on the one product their live sandbox actually returns:
   * Mastercard, virtual, USD, no-KYC to apply for, and activation by API
   * requiring an identity document.
   */
  const row = (overrides: Partial<CardProductEntity> = {}): CardProductEntity =>
    ({
      id: '1',
      publicId: 'a1b2c3d4-0000-4000-8000-000000000001',
      providerKey: CardProviderKey.HYPERCARD,
      providerProductId: '52400002',
      displayName: 'Mastercard Virtual USD',
      cardType: CardType.VIRTUAL,
      cardOrganisation: CardOrganisation.MASTERCARD,
      material: CardMaterial.PLASTIC,
      currencyCode: 'USD',
      issuanceFeeAmount: '20',
      issuanceFeeCurrency: 'USDT',
      annualFeeAmount: null,
      annualFeeCurrency: null,
      depositFeePercent: '1.5',
      depositMinPerTransaction: '10',
      depositMaxPerTransaction: '100000',
      depositMaxPerDay: '1000000',
      requiresInitialDeposit: true,
      depositMinInitial: '10',
      applicationMode: CardProductApplicationMode.NO_KYC,
      requiresKyc: false,
      activationMode: CardProductActivationMode.ISSUER_REQUEST,
      activationRequiresIdentityDocument: true,
      sensitiveDetailMode: CardProductSensitiveDetailMode.API,
      availableForIssuance: true,
      supportedOperations: [
        CardLifecycleOperation.BLOCK,
        CardLifecycleOperation.UNBLOCK,
      ],
      rawPayload: { card_type_id: '52400002' },
      syncedAt: secondsAgo(60),
      createdAt: secondsAgo(60),
      updatedAt: secondsAgo(60),
      ...overrides,
    }) as unknown as CardProductEntity;

  const list = (includeUnavailable = false) =>
    useCase.execute({
      providerKey: CardProviderKey.HYPERCARD,
      includeUnavailable,
    });

  beforeEach(async () => {
    repository = { find: jest.fn().mockResolvedValue([]) };
    cardIssuerRegistry = {
      resolve: jest
        .fn()
        .mockReturnValue(issuerDouble([CardCapability.PRODUCT_CATALOGUE])),
    };
    syncCardProductsUseCase = { execute: jest.fn().mockResolvedValue({}) };
    configGetOrThrow = jest.fn((key: string) =>
      key === 'CARD_PRODUCT_CATALOGUE_REFRESH_ON_READ' ? true : TTL_SECONDS,
    );

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ListCardProductsUseCase,
        {
          provide: getRepositoryToken(CardProductEntity),
          useValue: repository,
        },
        { provide: CardIssuerRegistry, useValue: cardIssuerRegistry },
        {
          provide: SyncCardProductsUseCase,
          useValue: syncCardProductsUseCase,
        },
        {
          provide: ConfigService,
          useValue: { getOrThrow: configGetOrThrow },
        },
      ],
    }).compile();

    useCase = moduleRef.get(ListCardProductsUseCase);
  });

  describe('the capability gate', () => {
    it('refuses a provider with no product catalogue, naming it', async () => {
      cardIssuerRegistry.resolve.mockReturnValue(issuerDouble([]));

      await expect(
        useCase.execute({
          providerKey: CardProviderKey.AXYS,
          includeUnavailable: false,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        useCase.execute({
          providerKey: CardProviderKey.AXYS,
          includeUnavailable: false,
        }),
      ).rejects.toThrow(/AXYS/);
    });

    it('refuses before reading the table or calling the provider', async () => {
      cardIssuerRegistry.resolve.mockReturnValue(issuerDouble([]));

      await expect(
        useCase.execute({
          providerKey: CardProviderKey.AXYS,
          includeUnavailable: false,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(repository.find).not.toHaveBeenCalled();
      expect(syncCardProductsUseCase.execute).not.toHaveBeenCalled();
    });

    it('propagates the registry’s rejection of a disabled provider', async () => {
      const disabled = new Error('Card provider "HYPERCARD" is not enabled');
      cardIssuerRegistry.resolve.mockImplementation(() => {
        throw disabled;
      });

      await expect(list()).rejects.toBe(disabled);
    });
  });

  describe('when to refresh', () => {
    it('never refreshes when the read path is not allowed to', async () => {
      // A refresh withdraws every stored row the provider's live listing omits.
      // Under test, one schema is shared by an application per spec file, so
      // that is every product another spec seeded.
      configGetOrThrow.mockImplementation((key: string) =>
        key === 'CARD_PRODUCT_CATALOGUE_REFRESH_ON_READ' ? false : TTL_SECONDS,
      );
      repository.find.mockResolvedValue([
        row({ syncedAt: new Date('2020-01-01T00:00:00.000Z') }),
      ]);

      await list();

      // Stale by any window, and still not refreshed.
      expect(syncCardProductsUseCase.execute).not.toHaveBeenCalled();
    });

    it('does not call the provider on a warm snapshot', async () => {
      repository.find.mockResolvedValue([row({ syncedAt: secondsAgo(60) })]);

      const result = await list();

      expect(syncCardProductsUseCase.execute).not.toHaveBeenCalled();
      expect(result.items).toHaveLength(1);
    });

    it('refreshes when nothing is stored for the provider', async () => {
      repository.find
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([row({ syncedAt: new Date() })]);

      const result = await list();

      expect(syncCardProductsUseCase.execute).toHaveBeenCalledWith(
        CardProviderKey.HYPERCARD,
      );
      expect(result.items).toHaveLength(1);
    });

    it('refreshes when the newest row is older than the window', async () => {
      repository.find
        .mockResolvedValueOnce([
          row({ syncedAt: secondsAgo(TTL_SECONDS + 60) }),
        ])
        .mockResolvedValueOnce([row({ syncedAt: new Date() })]);

      await list();

      expect(syncCardProductsUseCase.execute).toHaveBeenCalledTimes(1);
    });

    it('judges staleness on the newest row, not the oldest', async () => {
      repository.find.mockResolvedValue([
        row({ id: '1', syncedAt: secondsAgo(TTL_SECONDS + 60) }),
        row({ id: '2', syncedAt: secondsAgo(60) }),
      ]);

      await list();

      expect(syncCardProductsUseCase.execute).not.toHaveBeenCalled();
    });

    it('counts a withdrawn row towards freshness', async () => {
      // A sync moves `synced_at` on a withdrawn row too. Ignoring those rows
      // would make a fully-withdrawn catalogue look permanently cold and
      // refresh on every single request.
      repository.find.mockResolvedValue([
        row({ availableForIssuance: false, syncedAt: secondsAgo(60) }),
      ]);

      await list();

      expect(syncCardProductsUseCase.execute).not.toHaveBeenCalled();
    });
  });

  describe('when a refresh fails', () => {
    const unavailable = new CardProviderCatalogueUnavailableError(
      CardProviderKey.HYPERCARD,
    );

    it('serves the previous snapshot rather than an error', async () => {
      const stale = row({ syncedAt: secondsAgo(TTL_SECONDS + 60) });
      repository.find.mockResolvedValue([stale]);
      syncCardProductsUseCase.execute.mockRejectedValue(unavailable);

      const result = await list();

      expect(result.items).toHaveLength(1);
      expect(result.syncedAt).toEqual(stale.syncedAt);
    });

    it('reports the provider unavailable when there is no snapshot to serve', async () => {
      repository.find.mockResolvedValue([]);
      syncCardProductsUseCase.execute.mockRejectedValue(unavailable);

      await expect(list()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('does not retry the provider on the very next request', async () => {
      // Without a backoff every request during an outage calls out again and
      // waits out the transport's timeout before serving the snapshot it was
      // always going to serve.
      repository.find.mockResolvedValue([
        row({ syncedAt: secondsAgo(TTL_SECONDS + 60) }),
      ]);
      syncCardProductsUseCase.execute.mockRejectedValue(unavailable);

      await list();
      await list();
      await list();

      expect(syncCardProductsUseCase.execute).toHaveBeenCalledTimes(1);
    });

    it('still refuses a never-confirmed catalogue while the retry is suppressed', async () => {
      repository.find.mockResolvedValue([]);
      syncCardProductsUseCase.execute.mockRejectedValue(unavailable);

      await expect(list()).rejects.toBeInstanceOf(ServiceUnavailableException);
      // Second call is inside the backoff, so no provider call — but there is
      // still nothing honest to serve, so the answer must not change.
      await expect(list()).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(syncCardProductsUseCase.execute).toHaveBeenCalledTimes(1);
    });

    it('serves the previous snapshot when the refresh could not be stored', async () => {
      // A write the database refused is not the partner's problem either: the
      // rolled-back transaction leaves the previous snapshot whole, which is
      // exactly what an unreachable provider leaves. Letting this one through
      // instead is what reached a partner as a server fault.
      const stale = row({ syncedAt: secondsAgo(TTL_SECONDS + 60) });
      repository.find.mockResolvedValue([stale]);
      syncCardProductsUseCase.execute.mockRejectedValue(
        new CardProviderCatalogueNotStoredError(CardProviderKey.HYPERCARD),
      );

      const result = await list();

      expect(result.items).toHaveLength(1);
      expect(result.syncedAt).toEqual(stale.syncedAt);
    });

    it('reports the catalogue unavailable when a refresh could not be stored and there is no snapshot', async () => {
      repository.find.mockResolvedValue([]);
      syncCardProductsUseCase.execute.mockRejectedValue(
        new CardProviderCatalogueNotStoredError(CardProviderKey.HYPERCARD),
      );

      await expect(list()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('does not swallow a failure that is not the provider’s', async () => {
      // A named refresh failure degrades; an unnamed one does not. Catching
      // everything here would just as happily hide a bug of ours and report it
      // to the partner as a stale catalogue.
      const ourBug = new TypeError('rows.map is not a function');
      repository.find.mockResolvedValue([
        row({ syncedAt: secondsAgo(TTL_SECONDS + 60) }),
      ]);
      syncCardProductsUseCase.execute.mockRejectedValue(ourBug);

      await expect(
        useCase.execute({
          providerKey: CardProviderKey.HYPERCARD,
          includeUnavailable: false,
        }),
      ).rejects.toBe(ourBug);
    });
  });

  describe('a provider with no products at all', () => {
    it('treats a successful empty refresh as a confirmed catalogue', async () => {
      // The sync writes no rows for an empty catalogue, so nothing in the table
      // records that it was checked. Without tracking the successful refresh
      // itself, the snapshot reads as cold forever and every single request
      // calls the provider again.
      repository.find.mockResolvedValue([]);

      const first = await list();
      const second = await list();

      expect(syncCardProductsUseCase.execute).toHaveBeenCalledTimes(1);
      expect(first.items).toEqual([]);
      expect(second.items).toEqual([]);
      expect(second.syncedAt).toBeNull();
    });

    it('answers 200 with an empty list rather than refusing', async () => {
      repository.find.mockResolvedValue([]);

      await expect(list()).resolves.toMatchObject({ items: [] });
    });
  });

  describe('concurrent requests', () => {
    it('share one refresh instead of each firing their own', async () => {
      repository.find.mockResolvedValue([]);
      let release: (() => void) | undefined;
      syncCardProductsUseCase.execute.mockReturnValue(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );

      const inFlight = [list(), list(), list()];
      release?.();
      await Promise.all(inFlight);

      // Three requests arriving on a cold snapshot must not become three live
      // provider calls racing each other into the sync's duplicate-key restart.
      expect(syncCardProductsUseCase.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('what is returned', () => {
    it('excludes withdrawn products by default and includes them on request', async () => {
      repository.find.mockResolvedValue([
        row({ id: '1', publicId: 'available', availableForIssuance: true }),
        row({ id: '2', publicId: 'withdrawn', availableForIssuance: false }),
      ]);

      const byDefault = await list();
      const including = await list(true);

      expect(byDefault.items.map((item) => item.publicId)).toEqual([
        'available',
      ]);
      expect(including.items.map((item) => item.publicId)).toEqual([
        'available',
        'withdrawn',
      ]);
    });

    it('reports when the snapshot was last confirmed against the provider', async () => {
      const syncedAt = secondsAgo(120);
      repository.find.mockResolvedValue([row({ syncedAt })]);

      const result = await list();

      expect(result.syncedAt).toEqual(syncedAt);
      expect(result.providerKey).toBe(CardProviderKey.HYPERCARD);
    });

    it('reports a null snapshot time for a provider with an empty catalogue', async () => {
      repository.find.mockResolvedValue([]);

      const result = await list();

      expect(result.syncedAt).toBeNull();
      expect(result.items).toEqual([]);
    });

    it('projects a stored product onto the partner-facing shape', async () => {
      repository.find.mockResolvedValue([row()]);

      const [item] = (await list()).items;

      expect(item).toEqual({
        publicId: 'a1b2c3d4-0000-4000-8000-000000000001',
        displayName: 'Mastercard Virtual USD',
        cardType: CardType.VIRTUAL,
        cardOrganisation: CardOrganisation.MASTERCARD,
        material: CardMaterial.PLASTIC,
        currencyCode: 'USD',
        fees: {
          issuance: { amount: '20', currencyCode: 'USDT' },
          annual: null,
          depositFeePercent: '1.5',
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
        // This assertion is exhaustive and still let a new field through
        // unnoticed, which is worth knowing before trusting it again:
        // `toEqual` treats an `undefined` property as absent, so while the row
        // fixture below lacked this column the projection emitted `undefined`
        // and both sides compared equal.
        sensitiveDetailMode: CardProductSensitiveDetailMode.API,
        availableForIssuance: true,
        supportedOperations: [
          CardLifecycleOperation.BLOCK,
          CardLifecycleOperation.UNBLOCK,
        ],
      });
    });

    it('publishes an empty operation list rather than omitting the field', async () => {
      // An absent field would make "offers none" and "not known" identical.
      repository.find.mockResolvedValue([row({ supportedOperations: [] })]);

      const [item] = (await list()).items;

      expect(item?.supportedOperations).toStrictEqual([]);
    });

    it('leaks no provider vocabulary', async () => {
      repository.find.mockResolvedValue([row()]);

      const [item] = (await list()).items;

      // The provider's own handle for the product, the response it sent, and
      // our internal row id all stay on the server. A partner identifies a
      // product by `publicId` alone.
      expect(item).not.toHaveProperty('providerProductId');
      expect(item).not.toHaveProperty('rawPayload');
      expect(item).not.toHaveProperty('id');
      expect(JSON.stringify(item)).not.toContain('card_type_id');
    });

    it('projects the sensitive-detail mode a partner reads before choosing', async () => {
      // It answers "what will I be able to give my customer", which is worth
      // knowing before a card is opened rather than after — so it has to survive
      // the column-to-response projection, and that is what this pins.
      repository.find.mockResolvedValue([
        row({
          sensitiveDetailMode: CardProductSensitiveDetailMode.HOSTED_PAGE,
        }),
      ]);

      const [item] = (await list()).items;

      expect(item?.sensitiveDetailMode).toBe(
        CardProductSensitiveDetailMode.HOSTED_PAGE,
      );
    });

    it('projects a null sensitive-detail mode without withholding the product', async () => {
      // Null is what an unrecognised value stores, and unlike every other
      // unmapped code on this table it does not exclude the row: this field
      // describes how a card is later read, not whether one can be opened.
      repository.find.mockResolvedValue([row({ sensitiveDetailMode: null })]);

      const { items } = await list();

      expect(items).toHaveLength(1);
      expect(items[0]?.sensitiveDetailMode).toBeNull();
    });

    it('reports no activation document requirement when there is no activation call', async () => {
      // Null rather than false: `CARDHOLDER_DIRECT` has no call for a document
      // to ride on, which is a different claim from "a call that needs none".
      repository.find.mockResolvedValue([
        row({
          activationMode: CardProductActivationMode.CARDHOLDER_DIRECT,
          activationRequiresIdentityDocument: null,
        }),
      ]);

      const [item] = (await list()).items;

      expect(item?.activation).toEqual({
        mode: CardProductActivationMode.CARDHOLDER_DIRECT,
        requiresIdentityDocument: null,
      });
    });

    it('warns rather than silently advertising a half-populated fee as free', async () => {
      // The sync writes both halves together, so this row should be
      // unreachable — but `null` is documented to a partner as "the issuer
      // charges none", so a product costing 20 to open would otherwise be
      // advertised as free with nothing anywhere saying so.
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      repository.find.mockResolvedValue([
        row({ issuanceFeeAmount: '20', issuanceFeeCurrency: null }),
      ]);

      const [item] = (await list()).items;

      expect(item?.fees.issuance).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'half-populated issuance fee',
        ) as unknown as string,
      );
      warn.mockRestore();
    });

    it('reports an unstated fee as null rather than as a zero', async () => {
      repository.find.mockResolvedValue([
        row({
          issuanceFeeAmount: null,
          issuanceFeeCurrency: null,
          depositFeePercent: null,
        }),
      ]);

      const [item] = (await list()).items;

      expect(item?.fees).toEqual({
        issuance: null,
        annual: null,
        depositFeePercent: null,
      });
    });
  });
});
