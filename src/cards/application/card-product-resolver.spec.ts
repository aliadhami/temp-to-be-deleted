import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  CARD_PRODUCT_REFERENCE_FIELD,
  CardProductResolver,
} from './card-product-resolver';
import { CardCapability } from '../domain/card-capability.enum';
import { CardIssuerPort } from '../domain/card-issuer.port';
import { CardLifecycleOperation } from '../domain/card-lifecycle-operation.enum';
import { CardProductApplicationMode } from '../domain/card-product-application-mode.enum';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardType } from '../domain/card-type.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardApplicationEntity } from '../infrastructure/persistence/card-application.entity';
import { CardProductEntity } from '../infrastructure/persistence/card-product.entity';

describe('CardProductResolver', () => {
  let resolver: CardProductResolver;
  let repository: { findOne: jest.Mock; find: jest.Mock };
  let applicationRepository: { findOne: jest.Mock };
  let cardIssuerRegistry: { resolve: jest.Mock };

  // Typed against the port so the double cannot drift from the interface it
  // stands in for.
  type IssuerDouble = Pick<CardIssuerPort, 'capabilities'>;

  const issuerDouble = (capabilities: CardCapability[]): IssuerDouble => ({
    capabilities: new Set(capabilities),
  });

  const availableRow: Partial<CardProductEntity> = {
    id: '77',
    publicId: 'a1b2c3d4-0000-4000-8000-000000000001',
    providerKey: CardProviderKey.HYPERCARD,
    providerProductId: '52400002',
    applicationMode: CardProductApplicationMode.NO_KYC,
    cardType: CardType.VIRTUAL,
    currencyCode: 'USD',
    requiresInitialDeposit: true,
    depositMinInitial: '10',
    issuanceFeeAmount: null,
    issuanceFeeCurrency: null,
    availableForIssuance: true,
  };

  beforeEach(async () => {
    repository = { findOne: jest.fn(), find: jest.fn() };
    applicationRepository = { findOne: jest.fn() };
    cardIssuerRegistry = { resolve: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CardProductResolver,
        {
          provide: getRepositoryToken(CardProductEntity),
          useValue: repository,
        },
        {
          provide: getRepositoryToken(CardApplicationEntity),
          useValue: applicationRepository,
        },
        { provide: CardIssuerRegistry, useValue: cardIssuerRegistry },
      ],
    }).compile();

    resolver = moduleRef.get(CardProductResolver);
  });

  it('resolves an available product belonging to the resolved provider', async () => {
    cardIssuerRegistry.resolve.mockReturnValueOnce(
      issuerDouble([CardCapability.PRODUCT_CATALOGUE]),
    );
    repository.findOne.mockResolvedValueOnce({ ...availableRow });

    const result = await resolver.resolve({
      providerKey: CardProviderKey.HYPERCARD,
      cardProductPublicId: availableRow.publicId,
    });

    // The internal `id` is on the projection and nothing else is: an issuance
    // path has to write a foreign key at this row, which a `public_id` cannot
    // do. It never leaves the application layer.
    expect(result).toEqual({
      id: '77',
      publicId: availableRow.publicId,
      providerKey: CardProviderKey.HYPERCARD,
      providerProductId: '52400002',
      applicationMode: CardProductApplicationMode.NO_KYC,
      cardType: CardType.VIRTUAL,
      currencyCode: 'USD',
      requiresInitialDeposit: true,
      depositMinInitial: '10',
      issuanceFee: null,
    });
    // The `select` is asserted, not just the `where`: dropping it would load
    // `raw_payload` — the largest column in the row, kept only for replay — on
    // every issuance request, with every other assertion here still passing.
    expect(repository.findOne).toHaveBeenCalledWith({
      where: { publicId: availableRow.publicId },
      select: {
        id: true,
        publicId: true,
        providerKey: true,
        providerProductId: true,
        applicationMode: true,
        cardType: true,
        currencyCode: true,
        requiresInitialDeposit: true,
        depositMinInitial: true,
        issuanceFeeAmount: true,
        issuanceFeeCurrency: true,
        availableForIssuance: true,
      },
    });
  });

  it('carries a stated-no-minimum deposit mandate through as null', async () => {
    // The two are independent facts: an issuer can mandate an opening deposit
    // while stating no minimum for it, and collapsing that into the amount's
    // nullability would lose the mandate.
    cardIssuerRegistry.resolve.mockReturnValueOnce(
      issuerDouble([CardCapability.PRODUCT_CATALOGUE]),
    );
    repository.findOne.mockResolvedValueOnce({
      ...availableRow,
      requiresInitialDeposit: true,
      depositMinInitial: null,
    });

    const result = await resolver.resolve({
      providerKey: CardProviderKey.HYPERCARD,
      cardProductPublicId: availableRow.publicId,
    });

    expect(result).toMatchObject({
      requiresInitialDeposit: true,
      depositMinInitial: null,
    });
  });

  // `@IsOptional()` skips validation for `null` as well as `undefined`, and a
  // blank string is a field sent unfilled — so all three reach this layer as
  // "no reference" and must be answered identically.
  const absentReferences: [string, string | null | undefined][] = [
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a blank string', '   '],
  ];

  it.each(absentReferences)(
    'returns null when the provider has no catalogue and the reference is %s',
    async (_label, value) => {
      cardIssuerRegistry.resolve.mockReturnValueOnce(issuerDouble([]));

      const result = await resolver.resolve({
        providerKey: CardProviderKey.AXYS,
        cardProductPublicId: value,
      });

      expect(result).toBeNull();
      expect(repository.findOne).not.toHaveBeenCalled();
    },
  );

  it('refuses a reference supplied to a provider with no catalogue', async () => {
    cardIssuerRegistry.resolve.mockReturnValueOnce(issuerDouble([]));

    // The message, not just the class: three other paths in this method throw
    // BadRequestException, so the class alone would not prove which one fired.
    await expect(
      resolver.resolve({
        providerKey: CardProviderKey.AXYS,
        cardProductPublicId: 'some-public-id',
      }),
    ).rejects.toThrow(
      'Card provider "AXYS" does not support a product catalogue — cardProductPublicId must not be supplied',
    );
    expect(repository.findOne).not.toHaveBeenCalled();
  });

  it.each(absentReferences)(
    'refuses a catalogue provider when the reference is %s',
    async (_label, value) => {
      cardIssuerRegistry.resolve.mockReturnValueOnce(
        issuerDouble([CardCapability.PRODUCT_CATALOGUE]),
      );

      await expect(
        resolver.resolve({
          providerKey: CardProviderKey.HYPERCARD,
          cardProductPublicId: value,
        }),
      ).rejects.toThrow(
        `Card provider "HYPERCARD" requires a product reference — ${CARD_PRODUCT_REFERENCE_FIELD} is missing`,
      );
      // Never reaches the database: a null here throws a TypeORMError, which
      // would surface as a 500 rather than this 400.
      expect(repository.findOne).not.toHaveBeenCalled();
    },
  );

  it('trims a padded reference before looking it up', async () => {
    cardIssuerRegistry.resolve.mockReturnValueOnce(
      issuerDouble([CardCapability.PRODUCT_CATALOGUE]),
    );
    repository.findOne.mockResolvedValueOnce({ ...availableRow });

    await resolver.resolve({
      providerKey: CardProviderKey.HYPERCARD,
      cardProductPublicId: `  ${availableRow.publicId ?? ''}  `,
    });

    expect(repository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { publicId: availableRow.publicId },
      }),
    );
  });

  it('rejects an unknown product reference with 404', async () => {
    cardIssuerRegistry.resolve.mockReturnValueOnce(
      issuerDouble([CardCapability.PRODUCT_CATALOGUE]),
    );
    repository.findOne.mockResolvedValueOnce(null);

    // One call, asserted twice — the mocks are `…Once`, so resolving a second
    // time would exercise a registry that returns undefined rather than this
    // case.
    const attempt = resolver.resolve({
      providerKey: CardProviderKey.HYPERCARD,
      cardProductPublicId: 'unknown-id',
    });

    await expect(attempt).rejects.toThrow(NotFoundException);
    await expect(attempt).rejects.toThrow('Card product not found');
  });

  it('rejects a product belonging to a different provider, naming the mismatch', async () => {
    cardIssuerRegistry.resolve.mockReturnValueOnce(
      issuerDouble([CardCapability.PRODUCT_CATALOGUE]),
    );
    repository.findOne.mockResolvedValueOnce({
      ...availableRow,
      providerKey: CardProviderKey.AXYS,
    });

    await expect(
      resolver.resolve({
        providerKey: CardProviderKey.HYPERCARD,
        cardProductPublicId: availableRow.publicId,
      }),
    ).rejects.toThrow(
      `Card product "${availableRow.publicId}" belongs to provider "AXYS", not "HYPERCARD"`,
    );
  });

  it('rejects a product withdrawn from issuance with 409', async () => {
    cardIssuerRegistry.resolve.mockReturnValueOnce(
      issuerDouble([CardCapability.PRODUCT_CATALOGUE]),
    );
    repository.findOne.mockResolvedValueOnce({
      ...availableRow,
      availableForIssuance: false,
    });

    const attempt = resolver.resolve({
      providerKey: CardProviderKey.HYPERCARD,
      cardProductPublicId: availableRow.publicId,
    });

    await expect(attempt).rejects.toThrow(ConflictException);
    await expect(attempt).rejects.toThrow(
      `Card product "${availableRow.publicId}" is not available for issuance`,
    );
  });

  it('propagates the registry rejection for a disabled provider key', async () => {
    const error = new BadRequestException(
      'Card provider "AXYS" is not enabled',
    );
    cardIssuerRegistry.resolve.mockImplementationOnce(() => {
      throw error;
    });

    await expect(
      resolver.resolve({
        providerKey: CardProviderKey.AXYS,
        cardProductPublicId: undefined,
      }),
    ).rejects.toThrow(error);
    expect(repository.findOne).not.toHaveBeenCalled();
  });

  describe('reading what a page of products offers', () => {
    it('keys the operations on the product id', async () => {
      repository.find.mockResolvedValueOnce([
        { id: '77', supportedOperations: [CardLifecycleOperation.BLOCK] },
        { id: '78', supportedOperations: [] },
      ]);

      await expect(
        resolver.supportedOperationsByProductId(['77', '78']),
      ).resolves.toEqual(
        new Map([
          ['77', [CardLifecycleOperation.BLOCK]],
          ['78', []],
        ]),
      );
    });

    it('names its columns and never asks for the retained payload', async () => {
      repository.find.mockResolvedValueOnce([]);

      await resolver.supportedOperationsByProductId(['77']);

      const [options] = repository.find.mock.calls[0] as [
        { select: Record<string, unknown> },
      ];
      expect(options.select).toEqual({ id: true, supportedOperations: true });
      expect(options.select).not.toHaveProperty('rawPayload');
    });

    it('issues no query for a page whose cards name no product', async () => {
      await expect(
        resolver.supportedOperationsByProductId([]),
      ).resolves.toEqual(new Map());
      expect(repository.find).not.toHaveBeenCalled();
    });
  });

  describe('resolveByPublicId', () => {
    it('reads the provider off the row rather than from a caller', async () => {
      repository.findOne.mockResolvedValueOnce({
        ...availableRow,
        issuanceFeeAmount: '20',
        issuanceFeeCurrency: 'usdt',
      });

      const result = await resolver.resolveByPublicId(availableRow.publicId!);

      expect(result.providerKey).toBe(CardProviderKey.HYPERCARD);
      // Upper-cased, so nothing downstream reads a case difference as a
      // different currency.
      expect(result.issuanceFee).toEqual({
        amount: '20',
        currencyCode: 'USDT',
      });
    });

    it('leaves resolving the provider to the caller that needs the adapter', async () => {
      repository.findOne.mockResolvedValueOnce({ ...availableRow });

      await resolver.resolveByPublicId(availableRow.publicId!);

      expect(cardIssuerRegistry.resolve).not.toHaveBeenCalled();
    });

    it('carries no fee when the issuer publishes only half of one', async () => {
      repository.findOne.mockResolvedValueOnce({
        ...availableRow,
        issuanceFeeAmount: '20',
        issuanceFeeCurrency: null,
      });

      const result = await resolver.resolveByPublicId(availableRow.publicId!);

      expect(result.issuanceFee).toBeNull();
    });

    it('refuses a reference nothing holds', async () => {
      repository.findOne.mockResolvedValueOnce(null);

      await expect(resolver.resolveByPublicId('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('refuses a product withdrawn from issuance', async () => {
      repository.findOne.mockResolvedValueOnce({
        ...availableRow,
        availableForIssuance: false,
      });

      await expect(
        resolver.resolveByPublicId(availableRow.publicId!),
      ).rejects.toThrow(ConflictException);
    });

    it.each([['  '], ['']])('refuses a blank reference "%s"', async (value) => {
      await expect(resolver.resolveByPublicId(value)).rejects.toThrow(
        BadRequestException,
      );
      expect(repository.findOne).not.toHaveBeenCalled();
    });
  });
  describe('resolveForCard', () => {
    const depositRow = {
      publicId: availableRow.publicId,
      providerKey: CardProviderKey.HYPERCARD,
      providerProductId: '52400002',
      currencyCode: 'USD',
      depositMinPerTransaction: '10',
      depositMaxPerTransaction: '100000',
    };

    /** The joined read: the product arrives on the application row. */
    const withProduct = (overrides: Record<string, unknown> = {}): void => {
      applicationRepository.findOne.mockResolvedValueOnce({
        id: '3',
        cardProduct: { ...depositRow, ...overrides },
      });
    };

    const resolveForCard = () =>
      resolver.resolveForCard('5', CardProviderKey.HYPERCARD);

    it("resolves the product through the card's application row", async () => {
      withProduct();

      await expect(resolveForCard()).resolves.toEqual({
        publicId: availableRow.publicId,
        providerProductId: '52400002',
        currencyCode: 'USD',
        depositMinPerTransaction: '10',
        depositMaxPerTransaction: '100000',
      });
    });

    it('resolves a product the issuer has withdrawn from issuance', async () => {
      // Unlike every other rule here: a card opened under one still exists and
      // still accepts what the issuer offers against it.
      withProduct({ availableForIssuance: false });

      await expect(resolveForCard()).resolves.not.toBeNull();
    });

    it('reads the product in one query rather than two', async () => {
      withProduct();

      await resolveForCard();

      expect(applicationRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { cardId: '5' },
          relations: { cardProduct: true },
        }),
      );
      expect(repository.findOne).not.toHaveBeenCalled();
    });

    it('never carries a daily cap, even when the row holds one', async () => {
      // Deliberately unreachable: enforcing it needs a rolling sum in the
      // issuer's own timezone, and they apply it themselves.
      withProduct({ depositMaxPerDay: '30' });

      await expect(resolveForCard()).resolves.not.toHaveProperty(
        'depositMaxPerDay',
      );
    });

    it('refuses a product belonging to another provider', async () => {
      // The handle would otherwise be sent to an issuer as one of their own.
      withProduct({ providerKey: CardProviderKey.AXYS });

      await expect(resolveForCard()).resolves.toBeNull();
    });

    it('answers nothing for a card with no application row', async () => {
      applicationRepository.findOne.mockResolvedValueOnce(null);

      await expect(resolveForCard()).resolves.toBeNull();
    });

    it('answers nothing for an application naming no product', async () => {
      applicationRepository.findOne.mockResolvedValueOnce({
        id: '3',
        cardProduct: null,
      });

      await expect(resolveForCard()).resolves.toBeNull();
    });
  });
});
