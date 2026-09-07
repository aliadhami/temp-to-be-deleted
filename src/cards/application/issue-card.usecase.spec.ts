import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { CardApplicationStatus } from '../domain/card-application-status.enum';
import { CardCapability } from '../domain/card-capability.enum';
import { CardProductApplicationMode } from '../domain/card-product-application-mode.enum';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { CardProviderIntentRejectedError } from '../domain/card-provider-intent-rejected.error';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardProviderUnsupportedApplicationModeError } from '../domain/card-provider-unsupported-application-mode.error';
import { CardStatus } from '../domain/card-status.enum';
import { CardType } from '../domain/card-type.enum';
import { CardholderStatus } from '../domain/cardholder-status.enum';
import { IssueCardResult } from '../domain/card-issuer.port';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardApplicationEntity } from '../infrastructure/persistence/card-application.entity';
import { CardEventEntity } from '../infrastructure/persistence/card-event.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';
import { IssueCardDto } from '../api/dto/issue-card.dto';
import { CardholderEnrolmentResolver } from './cardholder-enrolment.resolver';
import {
  CARD_PRODUCT_REFERENCE_FIELD,
  CardProductResolver,
  ResolvedCardProduct,
} from './card-product-resolver';
import { IssueCardInput, IssueCardUseCase } from './issue-card.usecase';

describe('IssueCardUseCase', () => {
  let useCase: IssueCardUseCase;
  let cardholderRepository: { findOne: jest.Mock };
  let cardRepository: { create: jest.Mock; save: jest.Mock };
  let eventRepository: { create: jest.Mock; save: jest.Mock };
  let applicationRepository: { create: jest.Mock; save: jest.Mock };
  let cardIssuerRegistry: { resolve: jest.Mock };
  let enrolmentResolver: { require: jest.Mock };
  let cardProductResolver: { resolve: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  // Mirrors Axys, which declares ISSUE_VIRTUAL and deliberately not
  // ISSUE_PHYSICAL — no adapter has ever implemented the physical path.
  const adapter = {
    capabilities: new Set([
      CardCapability.ISSUE_VIRTUAL,
      // Axys accepts an embossed name, so the double that stands in for it
      // declares the flag too. The cases below that exercise an issuer which
      // does *not* take one build their own double.
      CardCapability.CUSTOM_NAME_ON_CARD,
    ]),
    issueCard: jest.fn(),
  };

  /** An issuer that names the card after the cardholder, like HyperCard. */
  const adapterWithoutCustomName = {
    capabilities: new Set([CardCapability.ISSUE_VIRTUAL]),
    issueCard: jest.fn(),
  };

  /** The cardholder's stored reference, which the adapter is handed and the
   * application row is deliberately not keyed by. */
  const providerCardholderId = '9f8b7c6d5e4f4a3b2c1d0e9f8a7b6c5d';

  /** The person's standing with the issuer the request names. */
  const enrolment = (providerKey = CardProviderKey.AXYS) => ({
    id: '11',
    cardholderId: '1',
    providerKey,
    providerCardholderId,
    status: CardholderStatus.APPROVED,
  });

  const input = (overrides: Partial<IssueCardInput> = {}): IssueCardInput => ({
    partnerId: 'partner-1',
    cardholderPublicId: 'ch-1',
    providerKey: CardProviderKey.AXYS,
    cardType: CardType.VIRTUAL,
    nameOnCard: 'ADA LOVELACE',
    currency: 'USD',
    ...overrides,
  });

  const product = (
    overrides: Partial<ResolvedCardProduct> = {},
  ): ResolvedCardProduct => ({
    id: '77',
    publicId: 'product-1',
    providerKey: CardProviderKey.HYPERCARD,
    providerProductId: '52400002',
    applicationMode: CardProductApplicationMode.NO_KYC,
    cardType: CardType.VIRTUAL,
    currencyCode: 'USD',
    requiresInitialDeposit: false,
    depositMinInitial: null,
    issuanceFee: null,
    ...overrides,
  });

  /**
   * Asserts against the last application row handed to `save`, which is what
   * carries the outcome.
   */
  const expectLastApplication = (fields: Record<string, unknown>): void => {
    expect(applicationRepository.save).toHaveBeenLastCalledWith(
      expect.objectContaining(fields),
    );
  };

  beforeEach(async () => {
    cardholderRepository = { findOne: jest.fn() };
    cardRepository = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => ({
        ...(x as object),
        id: '5',
        publicId: 'card-1',
      })),
    };
    eventRepository = { create: jest.fn((x: unknown) => x), save: jest.fn() };
    applicationRepository = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => ({ ...(x as object), id: '9' })),
    };
    cardIssuerRegistry = { resolve: jest.fn(() => adapter) };
    enrolmentResolver = { require: jest.fn() };
    cardProductResolver = { resolve: jest.fn().mockResolvedValue(null) };
    // Runs the callback against a manager whose repositories are the mocks
    // above, so the write phase is exercised rather than stubbed out — the
    // transaction boundary itself is what only the e2e spec can prove.
    dataSource = {
      transaction: jest.fn((run: (manager: EntityManager) => unknown) =>
        run({
          getRepository: (target: unknown) =>
            target === CardEntity ? cardRepository : applicationRepository,
        } as unknown as EntityManager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IssueCardUseCase,
        {
          provide: getRepositoryToken(CardholderEntity),
          useValue: cardholderRepository,
        },
        { provide: getRepositoryToken(CardEntity), useValue: cardRepository },
        {
          provide: getRepositoryToken(CardEventEntity),
          useValue: eventRepository,
        },
        {
          provide: getRepositoryToken(CardApplicationEntity),
          useValue: applicationRepository,
        },
        { provide: CardIssuerRegistry, useValue: cardIssuerRegistry },
        {
          provide: CardholderEnrolmentResolver,
          useValue: enrolmentResolver,
        },
        { provide: CardProductResolver, useValue: cardProductResolver },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    useCase = module.get(IssueCardUseCase);
    jest.clearAllMocks();
    cardIssuerRegistry.resolve.mockReturnValue(adapter);
    cardProductResolver.resolve.mockResolvedValue(null);
    cardholderRepository.findOne.mockResolvedValue({
      id: '1',
      publicId: 'ch-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      userIp: null,
      identityProvenance: { callingCode: '44', cellNumber: '1234567890' },
    });
    enrolmentResolver.require.mockResolvedValue(enrolment());
    adapter.issueCard.mockResolvedValue({
      status: CardStatus.NOT_ACTIVATED,
    } satisfies IssueCardResult);
  });

  describe('the enrolment gate', () => {
    it('refuses an issuer this cardholder was never put to', async () => {
      // An approval one issuer gave says nothing about another, which is the
      // whole reason issuance resolves an enrolment rather than reading a
      // status off the person.
      enrolmentResolver.require.mockRejectedValueOnce(new ConflictException());

      await expect(
        useCase.execute(input({ providerKey: CardProviderKey.HYPERCARD })),
      ).rejects.toThrow(ConflictException);

      expect(cardRepository.save).not.toHaveBeenCalled();
      expect(adapter.issueCard).not.toHaveBeenCalled();
    });

    it('refuses an enrolment the issuer has not approved', async () => {
      enrolmentResolver.require.mockResolvedValue({
        ...enrolment(),
        status: CardholderStatus.UNDER_REVIEW,
      });

      const error: unknown = await useCase
        .execute(input())
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toContain('AXYS');
      expect(cardRepository.save).not.toHaveBeenCalled();
    });

    it('refuses an approved enrolment that never reached the issuer', async () => {
      // Approved with no provider reference means onboarding did not complete,
      // and the reference is the account the card would be opened against.
      enrolmentResolver.require.mockResolvedValue({
        ...enrolment(),
        providerCardholderId: null,
      });

      await expect(useCase.execute(input())).rejects.toThrow(ConflictException);
      expect(adapter.issueCard).not.toHaveBeenCalled();
    });

    it('resolves the enrolment on the issuer the request names', async () => {
      await useCase.execute(input({ providerKey: CardProviderKey.AXYS }));

      expect(enrolmentResolver.require).toHaveBeenCalledWith(
        '1',
        CardProviderKey.AXYS,
      );
    });
  });

  it('issues a virtual card when ISSUE_VIRTUAL is declared', async () => {
    adapter.issueCard.mockResolvedValueOnce({
      providerCardId: 'axys-card-1',
      status: CardStatus.NOT_ACTIVATED,
      maskedPan: '424904******4589',
    } satisfies IssueCardResult);

    await useCase.execute(input());

    expect(adapter.issueCard).toHaveBeenCalled();
    expect(cardRepository.save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        providerCardId: 'axys-card-1',
        maskedPan: '424904******4589',
      }),
    );
  });

  it('persists the card and writes the event when the provider returns neither id nor PAN', async () => {
    // An asynchronous issuer acknowledges the application and nothing more —
    // the card id and number arrive from a later result lookup.
    adapter.issueCard.mockResolvedValueOnce({
      status: CardStatus.NOT_ACTIVATED,
    } satisfies IssueCardResult);

    const result = await useCase.execute(input());

    expect(cardRepository.save).toHaveBeenCalledTimes(2);
    expect(cardRepository.save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        providerCardId: null,
        maskedPan: null,
        status: CardStatus.NOT_ACTIVATED,
      }),
    );
    expect(eventRepository.save).toHaveBeenCalledTimes(1);
    expect(eventRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ toStatus: CardStatus.NOT_ACTIVATED }),
    );
    expect(result).toEqual({
      publicId: 'card-1',
      status: CardStatus.NOT_ACTIVATED,
      maskedPan: null,
    });
  });

  it('persists the id and nulls the PAN when only one of the two comes back', async () => {
    // The two fields are coalesced independently, so the mixed case is the one
    // that catches them being crossed over.
    adapter.issueCard.mockResolvedValueOnce({
      providerCardId: 'provider-card-1',
      status: CardStatus.NOT_ACTIVATED,
    } satisfies IssueCardResult);

    const result = await useCase.execute(input());

    expect(cardRepository.save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        providerCardId: 'provider-card-1',
        maskedPan: null,
      }),
    );
    expect(result.maskedPan).toBeNull();
  });

  it('refuses a physical card when only ISSUE_VIRTUAL is declared', async () => {
    // The capability is chosen by requested form factor, so an adapter that
    // issues virtual cards only is never credited with physical issuance.
    await expect(
      useCase.execute(input({ cardType: CardType.PHYSICAL })),
    ).rejects.toThrow(ForbiddenException);
    expect(adapter.issueCard).not.toHaveBeenCalled();
  });

  it('writes no card row when the capability is missing', async () => {
    // Persistence-first: a refusal below the save would orphan a
    // NOT_ACTIVATED card for a provider that cannot issue one.
    await expect(
      useCase.execute(input({ cardType: CardType.PHYSICAL })),
    ).rejects.toThrow(ForbiddenException);

    expect(cardRepository.create).not.toHaveBeenCalled();
    expect(cardRepository.save).not.toHaveBeenCalled();
  });

  describe('the application row', () => {
    it('is written before the provider is called, keyed by the card it is for', async () => {
      await useCase.execute(input());

      // The card's own public id, never the cardholder's: the reference
      // identifies the attempt, and one attempt is one card.
      expect(applicationRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'card-1',
          status: CardApplicationStatus.DRAFT,
        }),
      );
      expect(applicationRepository.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ requestId: providerCardholderId }),
      );

      const applicationWrittenFirst =
        applicationRepository.save.mock.invocationCallOrder[0] ?? Infinity;
      const providerCalledAfter =
        adapter.issueCard.mock.invocationCallOrder[0] ?? -Infinity;
      expect(applicationWrittenFirst).toBeLessThan(providerCalledAfter);
    });

    it('takes its provider key from the card row rather than from request input', async () => {
      // Nothing in the database keeps the copy in step with `card.provider_key`,
      // and a row where the two disagree resolves the adapter from one issuer
      // while the card taking the result belongs to another.
      enrolmentResolver.require.mockResolvedValue(
        enrolment(CardProviderKey.HYPERCARD),
      );

      await useCase.execute(input({ providerKey: CardProviderKey.HYPERCARD }));

      expect(applicationRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ providerKey: CardProviderKey.HYPERCARD }),
      );
    });

    it('moves to SUBMITTED once the issuer has acknowledged', async () => {
      await useCase.execute(input());

      expectLastApplication({
        status: CardApplicationStatus.SUBMITTED,
        reasonCode: null,
        message: null,
      });
    });

    it('is marked SUBMITTED before the card row is updated', async () => {
      // The order is load-bearing, not incidental.
      await useCase.execute(input());

      const applicationMarked =
        applicationRepository.save.mock.invocationCallOrder.at(-1) ?? Infinity;
      const cardUpdated =
        cardRepository.save.mock.invocationCallOrder.at(-1) ?? -Infinity;
      expect(applicationMarked).toBeLessThan(cardUpdated);
    });

    it('is left SUBMITTED, not DRAFT, when the card update then fails', async () => {
      // The regression this ordering exists for: the issuer accepted the
      // application, so it must be resolvable afterwards even though the
      // request failed.
      cardRepository.save
        .mockImplementationOnce((x: unknown) => ({
          ...(x as object),
          id: '5',
          publicId: 'card-1',
        }))
        .mockImplementationOnce(() => {
          throw new Error('database is gone');
        });

      await expect(useCase.execute(input())).rejects.toThrow(
        'database is gone',
      );

      expectLastApplication({ status: CardApplicationStatus.SUBMITTED });
    });

    it('records which catalogue product was applied for', async () => {
      // Nothing else in the schema does — `card` carries only the form factor
      // and a currency, so without this column nothing can say afterwards which
      // catalogue row a card came from.
      cardProductResolver.resolve.mockResolvedValue(product({ id: '77' }));

      await useCase.execute(
        input({ cardProductPublicId: '9f8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d' }),
      );

      expect(applicationRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ cardProductId: '77' }),
      );
    });

    it('records no product for an issuer that publishes no catalogue', async () => {
      await useCase.execute(input());

      expect(applicationRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ cardProductId: null }),
      );
    });
  });

  describe('the product reference', () => {
    it('is passed to the resolver exactly as the partner supplied it', async () => {
      cardProductResolver.resolve.mockResolvedValue(product());

      await useCase.execute(input({ cardProductPublicId: 'product-uuid' }));

      expect(cardProductResolver.resolve).toHaveBeenCalledWith({
        providerKey: CardProviderKey.AXYS,
        cardProductPublicId: 'product-uuid',
      });
    });

    it('names the field the resolver names, so both messages point at one slot', () => {
      // A rename on either side alone would send partners hunting for a field
      // their body has no slot for, and nothing at runtime would fail.
      const dto = new IssueCardDto();
      dto.cardProductPublicId = 'product-uuid';

      expect(CARD_PRODUCT_REFERENCE_FIELD in dto).toBe(true);
    });

    it('reaches the adapter as the provider handle and the application mode', async () => {
      cardProductResolver.resolve.mockResolvedValue(product());

      await useCase.execute(input({ cardProductPublicId: 'product-uuid' }));

      expect(adapter.issueCard).toHaveBeenCalledWith(
        providerCardholderId,
        expect.objectContaining({
          cardProduct: {
            providerProductId: '52400002',
            applicationMode: CardProductApplicationMode.NO_KYC,
          },
        }),
        {},
        expect.any(String),
      );
    });

    it('writes nothing when the resolver refuses', async () => {
      // Resolved before the transaction, so an unknown, foreign or withdrawn
      // product cannot strand a card row. The rules themselves are the
      // resolver's and are proven in its own spec.
      cardProductResolver.resolve.mockRejectedValue(
        new ConflictException('Card product "x" is not available for issuance'),
      );

      await expect(
        useCase.execute(input({ cardProductPublicId: 'product-uuid' })),
      ).rejects.toThrow(ConflictException);

      expect(cardRepository.save).not.toHaveBeenCalled();
      expect(applicationRepository.save).not.toHaveBeenCalled();
      expect(adapter.issueCard).not.toHaveBeenCalled();
    });
  });

  describe('the opening deposit', () => {
    it('is refused as missing when the product mandates one', async () => {
      cardProductResolver.resolve.mockResolvedValue(
        product({ requiresInitialDeposit: true, depositMinInitial: '10' }),
      );

      await expect(
        useCase.execute(input({ cardProductPublicId: 'product-uuid' })),
      ).rejects.toThrow(BadRequestException);

      expect(cardRepository.save).not.toHaveBeenCalled();
      expect(adapter.issueCard).not.toHaveBeenCalled();
    });

    it('names the minimum in the refusal, so the partner knows what to send', async () => {
      cardProductResolver.resolve.mockResolvedValue(
        product({ requiresInitialDeposit: true, depositMinInitial: '10' }),
      );

      await expect(
        useCase.execute(input({ cardProductPublicId: 'product-uuid' })),
      ).rejects.toThrow(/minimum 10 USD/);
    });

    it('is refused below the product minimum', async () => {
      // Not merely a smaller number: their application accepts it and parks the
      // card at pending-payment, which is a card that never progresses rather
      // than an error anyone can see.
      cardProductResolver.resolve.mockResolvedValue(
        product({ requiresInitialDeposit: true, depositMinInitial: '10' }),
      );

      await expect(
        useCase.execute(
          input({
            cardProductPublicId: 'product-uuid',
            initialDepositAmount: '9.99999999',
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts an amount exactly on the minimum', async () => {
      // The boundary is the case a float comparison gets wrong, which is why
      // both sides are scaled and compared as integers.
      cardProductResolver.resolve.mockResolvedValue(
        product({
          requiresInitialDeposit: true,
          depositMinInitial: '10.00000000',
        }),
      );

      await useCase.execute(
        input({
          cardProductPublicId: 'product-uuid',
          initialDepositAmount: '10',
        }),
      );

      expect(adapter.issueCard).toHaveBeenCalled();
    });

    it('is recorded on the application row and sent to the adapter', async () => {
      cardProductResolver.resolve.mockResolvedValue(
        product({ requiresInitialDeposit: true, depositMinInitial: '10' }),
      );

      await useCase.execute(
        input({
          cardProductPublicId: 'product-uuid',
          initialDepositAmount: '25.5',
        }),
      );

      expect(applicationRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ initialDepositAmount: '25.5' }),
      );
      expect(adapter.issueCard).toHaveBeenCalledWith(
        providerCardholderId,
        expect.objectContaining({ initialDepositAmount: '25.5' }),
        {},
        expect.any(String),
      );
    });

    it('is null on the row when the product mandates none and none was sent', async () => {
      // Null means none was committed, which is not the same as zero.
      cardProductResolver.resolve.mockResolvedValue(product());

      await useCase.execute(input({ cardProductPublicId: 'product-uuid' }));

      expect(applicationRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ initialDepositAmount: null }),
      );
    });

    it('is passed through for a product that mandates none but was given one', async () => {
      // "No mandate" is not "no deposit accepted" — their application field is
      // optional in general.
      cardProductResolver.resolve.mockResolvedValue(product());

      await useCase.execute(
        input({
          cardProductPublicId: 'product-uuid',
          initialDepositAmount: '5',
        }),
      );

      expect(adapter.issueCard).toHaveBeenCalledWith(
        providerCardholderId,
        expect.objectContaining({ initialDepositAmount: '5' }),
        {},
        expect.any(String),
      );
    });

    it('is checked against the minimum even when the product mandates none', async () => {
      // The mandate and the minimum are independent facts on the product.
      cardProductResolver.resolve.mockResolvedValue(
        product({ requiresInitialDeposit: false, depositMinInitial: '10' }),
      );

      await expect(
        useCase.execute(
          input({
            cardProductPublicId: 'product-uuid',
            initialDepositAmount: '1',
          }),
        ),
      ).rejects.toThrow(BadRequestException);

      expect(adapter.issueCard).not.toHaveBeenCalled();
    });

    it('is still optional when the product mandates none', async () => {
      // The other half of the case above: a stated minimum is not a mandate,
      // so sending nothing stays legal.
      cardProductResolver.resolve.mockResolvedValue(
        product({ requiresInitialDeposit: false, depositMinInitial: '10' }),
      );

      await useCase.execute(input({ cardProductPublicId: 'product-uuid' }));

      expect(adapter.issueCard).toHaveBeenCalled();
      expect(applicationRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ initialDepositAmount: null }),
      );
    });

    it('refuses a stored minimum carrying more precision than it compares at', async () => {
      // Truncating instead would round the minimum *down*, so `10.000000001`
      // would compare equal to a supplied `10` and admit an amount below the
      // figure the comparison exists to enforce.
      cardProductResolver.resolve.mockResolvedValue(
        product({
          requiresInitialDeposit: true,
          depositMinInitial: '10.000000001',
        }),
      );

      await expect(
        useCase.execute(
          input({
            cardProductPublicId: 'product-uuid',
            initialDepositAmount: '10',
          }),
        ),
      ).rejects.toThrow(BadRequestException);

      expect(adapter.issueCard).not.toHaveBeenCalled();
    });

    it('refuses rather than applying with an unchecked amount when the stored minimum is unreadable', async () => {
      cardProductResolver.resolve.mockResolvedValue(
        product({ requiresInitialDeposit: true, depositMinInitial: 'n/a' }),
      );

      await expect(
        useCase.execute(
          input({
            cardProductPublicId: 'product-uuid',
            initialDepositAmount: '10',
          }),
        ),
      ).rejects.toThrow(BadRequestException);

      expect(adapter.issueCard).not.toHaveBeenCalled();
    });
  });

  describe('the requested form factor', () => {
    it('is refused when it disagrees with the resolved product', async () => {
      // The capability gate above reads the *requested* type, so it passes a
      // virtual request against a physical product and the application opens a
      // physical card while the row records VIRTUAL.
      cardProductResolver.resolve.mockResolvedValue(
        product({ cardType: CardType.PHYSICAL }),
      );

      await expect(
        useCase.execute(
          input({
            cardProductPublicId: 'product-uuid',
            cardType: CardType.VIRTUAL,
          }),
        ),
      ).rejects.toThrow(BadRequestException);

      expect(cardRepository.save).not.toHaveBeenCalled();
      expect(adapter.issueCard).not.toHaveBeenCalled();
    });

    it('is checked before the opening deposit', async () => {
      // A form factor that disagrees is the more fundamental fault; answering
      // the deposit first would send a partner to fix a figure on a request
      // that was never going to open the card they asked for.
      cardProductResolver.resolve.mockResolvedValue(
        product({
          cardType: CardType.PHYSICAL,
          requiresInitialDeposit: true,
          depositMinInitial: '10',
        }),
      );

      await expect(
        useCase.execute(
          input({
            cardProductPublicId: 'product-uuid',
            cardType: CardType.VIRTUAL,
          }),
        ),
      ).rejects.toThrow(/issues physical cards/);
    });
  });

  describe('the requested currency', () => {
    it('is refused when it disagrees with the resolved product', async () => {
      // The card is denominated in the product's currency whatever the request
      // says, so accepting a mismatch stores a `card.currency` the issued card
      // does not have.
      cardProductResolver.resolve.mockResolvedValue(
        product({ currencyCode: 'EUR' }),
      );

      await expect(
        useCase.execute(
          input({ cardProductPublicId: 'product-uuid', currency: 'USD' }),
        ),
      ).rejects.toThrow(BadRequestException);

      expect(cardRepository.save).not.toHaveBeenCalled();
    });

    it('is accepted unchecked for an issuer with no catalogue', async () => {
      // Nothing to check it against — the requested currency is the only
      // statement of it there is.
      await useCase.execute(input({ currency: 'GBP' }));

      expect(cardRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ currency: 'GBP' }),
      );
    });

    it('is taken from the product when the request omits it', async () => {
      // A catalogue makes the field redundant: the currency belongs to the
      // product already chosen, so a partner should not have to restate it.
      cardProductResolver.resolve.mockResolvedValue(
        product({ currencyCode: 'EUR' }),
      );

      await useCase.execute(
        input({ cardProductPublicId: 'product-uuid', currency: null }),
      );

      expect(cardRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ currency: 'EUR' }),
      );
    });

    it('is required when the provider publishes no catalogue', async () => {
      // Nothing to derive it from, and defaulting would mean guessing what a
      // card is denominated in.
      await expect(useCase.execute(input({ currency: null }))).rejects.toThrow(
        BadRequestException,
      );

      expect(cardRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('the name on the card', () => {
    /** A cardholder on the issuer that names the card after the person. */
    const namelessIssuerCardholder = {
      id: '1',
      publicId: 'ch-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      userIp: null,
      identityProvenance: { callingCode: '44', cellNumber: '1234567890' },
    };

    const withoutCustomName = () => {
      cardIssuerRegistry.resolve.mockReturnValue(adapterWithoutCustomName);
      cardholderRepository.findOne.mockResolvedValue(namelessIssuerCardholder);
      enrolmentResolver.require.mockResolvedValue(
        enrolment(CardProviderKey.HYPERCARD),
      );
      adapterWithoutCustomName.issueCard.mockResolvedValue({
        status: CardStatus.NOT_ACTIVATED,
      } satisfies IssueCardResult);
    };

    it('is required when the issuer lets the caller choose it', async () => {
      await expect(
        useCase.execute(input({ nameOnCard: null })),
      ).rejects.toThrow(BadRequestException);

      expect(cardRepository.save).not.toHaveBeenCalled();
    });

    it('is refused when the issuer cannot print a chosen name', async () => {
      // The defect this capability exists for: accepting it would store and
      // discard it, and `name_on_card` is returned by no read, so nothing a
      // partner can observe would ever reveal that it was ignored.
      withoutCustomName();

      const thrown = await useCase
        .execute(input({ nameOnCard: 'MY COMPANY LTD' }))
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as Error).message).toContain('nameOnCard');
      expect(cardRepository.save).not.toHaveBeenCalled();
      expect(adapterWithoutCustomName.issueCard).not.toHaveBeenCalled();
    });

    it("is derived from the cardholder's own name when none is taken", async () => {
      // What such an issuer actually prints, so the stored row describes the
      // card that exists rather than the one that was asked for.
      withoutCustomName();

      await useCase.execute(input({ nameOnCard: null }));

      expect(cardRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ nameOnCard: 'Ada Lovelace' }),
      );
    });

    it('refuses a cardholder with no name to print, rather than storing an empty one', async () => {
      // The shared onboarding DTO validates names with a bare `@IsString()`, so
      // an issuer that imposes no rules of its own can hold empty ones. Storing
      // `''` would be a legal insert carrying no information in the one column
      // meant to say what the card reads.
      withoutCustomName();
      cardholderRepository.findOne.mockResolvedValue({
        ...namelessIssuerCardholder,
        firstName: '',
        lastName: '',
      });

      await expect(
        useCase.execute(input({ nameOnCard: null })),
      ).rejects.toThrow(ConflictException);

      expect(cardRepository.save).not.toHaveBeenCalled();
    });

    it('trims a long derived name by code point, never splitting a character', async () => {
      // `slice` cuts UTF-16 units, so a pair straddling the limit would leave
      // a lone surrogate — not valid UTF-8, and stored corrupt rather than
      // short.
      withoutCustomName();
      cardholderRepository.findOne.mockResolvedValue({
        ...namelessIssuerCardholder,
        firstName: `A${'😀'.repeat(100)}`,
        lastName: '😀'.repeat(100),
      });

      // Captured through the mock rather than read back out of
      // `create.mock.calls`: indexing a `jest.Mock`'s calls is an unsafe member
      // access on an `any` and an error under this repository's lint.
      let created: { nameOnCard: string } | undefined;
      cardRepository.create.mockImplementation((row: unknown) => {
        created = row as { nameOnCard: string };
        return row;
      });

      await useCase.execute(input({ nameOnCard: null }));

      const stored = created?.nameOnCard ?? '';
      // Bounded by code point, which is what the column counts.
      expect([...stored]).toHaveLength(150);
      // And no *lone* surrogate anywhere — a complete pair iterates as one
      // two-unit code point, so a single unit in that range is a split one.
      // Asserting on the final character alone would be vacuous: a valid emoji
      // ends with a low surrogate too.
      const loneSurrogate = [...stored].some(
        (codePoint) =>
          codePoint.length === 1 &&
          codePoint.charCodeAt(0) >= 0xd800 &&
          codePoint.charCodeAt(0) <= 0xdfff,
      );
      expect(loneSurrogate).toBe(false);
    });

    it('sends the settled name to the adapter, not the request', async () => {
      withoutCustomName();

      await useCase.execute(input({ nameOnCard: null }));

      expect(adapterWithoutCustomName.issueCard).toHaveBeenCalledWith(
        providerCardholderId,
        expect.objectContaining({ nameOnCard: 'Ada Lovelace' }),
        {},
        expect.any(String),
      );
    });
  });

  describe('when the provider call fails', () => {
    it('marks the application failed rather than stranding the card', async () => {
      // The card row cannot tell "sent, awaiting outcome" from "never sent" —
      // for an asynchronous issuer a NOT_ACTIVATED card with a null provider id
      // is the successful state. The application row is what distinguishes
      // them.
      adapter.issueCard.mockRejectedValue(new Error('connection reset'));

      await expect(useCase.execute(input())).rejects.toThrow(
        'connection reset',
      );

      expectLastApplication({
        status: CardApplicationStatus.SUBMISSION_FAILED,
        reasonCode: 'SUBMISSION_ERROR',
        message: 'connection reset',
      });
    });

    it('leaves the card row in place, as the evidence an attempt was made', async () => {
      // Failed, not deleted: an issuer that timed out may well have taken the
      // application.
      adapter.issueCard.mockRejectedValue(new Error('connection reset'));

      await expect(useCase.execute(input())).rejects.toThrow();

      expect(cardRepository.save).toHaveBeenCalledTimes(1);
      expect(eventRepository.save).not.toHaveBeenCalled();
    });

    it('answers an unsupported application mode with a 400 naming the field', async () => {
      // The adapter's error names the mode and the modes it serves and names no
      // request field, because that is this layer's vocabulary — so this layer
      // supplies it.
      const refusal = new CardProviderUnsupportedApplicationModeError(
        CardProviderKey.HYPERCARD,
        CardProductApplicationMode.FULL_KYC,
        [CardProductApplicationMode.NO_KYC],
      );
      adapter.issueCard.mockRejectedValue(refusal);

      const thrown = await useCase
        .execute(input())
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as Error).message).toContain(CARD_PRODUCT_REFERENCE_FIELD);
      expect((thrown as Error).cause).toBe(refusal);
    });

    it('answers a state refusal with a 409, whichever issuer raised it', async () => {
      // Reachable on the live Axys path from an HTTP 409 as readily as from a
      // coded envelope, and unmapped until now — so this is a fix on both
      // paths, not only the one that motivated it.
      const conflict = new CardProviderConflictError(
        CardProviderKey.HYPERCARD,
        'A0011',
        'Card application not currently supported',
      );
      adapter.issueCard.mockRejectedValue(conflict);

      const thrown = await useCase
        .execute(input())
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(ConflictException);
      expect((thrown as Error).cause).toBe(conflict);
    });

    it('does not echo the provider message into the response body', async () => {
      // That message is built around the issuer's own wire text and carries
      // their HTTP status, their code and our internal operation name — remote
      // content of unknown shape. It survives on the `cause`, which is where a
      // log can still read it.
      const conflict = new CardProviderConflictError(
        CardProviderKey.HYPERCARD,
        'A0011',
        'HyperCard card application failed (HTTP 200, code=A0011): Card application not currently supported',
      );
      adapter.issueCard.mockRejectedValue(conflict);

      const thrown = await useCase
        .execute(input())
        .catch((error: unknown) => error);

      const message = (thrown as Error).message;
      expect(message).not.toContain('HTTP 200');
      expect(message).not.toContain('A0011');
      expect(message).not.toContain('card application failed');
      expect((thrown as Error).cause).toBe(conflict);
    });

    it('records an issuer refusal as REJECTED, not SUBMISSION_FAILED', async () => {
      // A conflict means the issuer read the application and declined it, so
      // it was unambiguously sent.
      adapter.issueCard.mockRejectedValue(
        new CardProviderConflictError(
          CardProviderKey.HYPERCARD,
          'A0016',
          'This type of card has reached the limit of card issuance',
        ),
      );

      await expect(useCase.execute(input())).rejects.toThrow(ConflictException);

      expectLastApplication({
        status: CardApplicationStatus.REJECTED,
        reasonCode: 'A0016',
      });
    });

    it("records the issuer's own code on a state refusal", async () => {
      adapter.issueCard.mockRejectedValue(
        new CardProviderConflictError(
          CardProviderKey.HYPERCARD,
          'A0011',
          'Card application not currently supported',
        ),
      );

      await expect(useCase.execute(input())).rejects.toThrow(ConflictException);

      expectLastApplication({ reasonCode: 'A0011' });
    });

    it('answers a refused value with a 400', async () => {
      adapter.issueCard.mockRejectedValue(
        new CardProviderIntentRejectedError(
          CardProviderKey.HYPERCARD,
          'cardProductPublicId',
          'this issuer opens a card against a catalogue product',
        ),
      );

      await expect(useCase.execute(input())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('reports the provider failure even when the bookkeeping write also fails', async () => {
      // These writes run in exactly the circumstances that break writes, and
      // the caller has to hear about the cause rather than the symptom.
      adapter.issueCard.mockRejectedValue(new Error('connection reset'));
      applicationRepository.save.mockImplementation((x: unknown) => {
        const row = x as { status: CardApplicationStatus };
        if (row.status !== CardApplicationStatus.DRAFT) {
          throw new Error('database is gone');
        }
        return { ...(x as object), id: '9' };
      });

      await expect(useCase.execute(input())).rejects.toThrow(
        'connection reset',
      );
    });
  });

  describe('the write transaction', () => {
    it('puts both rows in one transaction', async () => {
      await useCase.execute(input());

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('gives a cardholder a second card, with a reference of its own', async () => {
      // Nothing caps a cardholder at one card.
      const bothFormFactors = {
        capabilities: new Set([
          CardCapability.ISSUE_VIRTUAL,
          CardCapability.ISSUE_PHYSICAL,
          CardCapability.CUSTOM_NAME_ON_CARD,
        ]),
        issueCard: jest.fn().mockResolvedValue({
          providerCardId: 'p-1',
          status: CardStatus.NOT_ACTIVATED,
        } satisfies IssueCardResult),
      };
      cardIssuerRegistry.resolve.mockReturnValue(bothFormFactors);

      // A public id is assigned on insert only. The second save of each pass
      // carries the provider's answer back onto a row that already has one.
      let inserted = 0;
      cardRepository.save.mockImplementation((x: unknown) => {
        const row = x as { id?: string; publicId?: string };
        if (row.publicId) return row;
        inserted += 1;
        return { ...row, id: String(inserted), publicId: `card-${inserted}` };
      });

      await useCase.execute(input({ cardType: CardType.PHYSICAL }));
      await useCase.execute(input({ cardType: CardType.VIRTUAL }));

      const written = (
        applicationRepository.create.mock.calls as unknown as [
          { requestId: string },
        ][]
      ).map(([row]) => row.requestId);
      expect(written).toEqual(['card-1', 'card-2']);
    });

    it('writes both rows through the transaction manager, never around it', async () => {
      // What makes the rollback real. The card insert is only covered by the
      // transaction if it goes through the manager's repository — an insert
      // through the injected one commits on its own, and a failure on the
      // application leaves a card the partner can see and can never use. The
      // rollback itself is the database's, so this is the strongest claim a
      // unit test can make about it.
      const scopedCards = {
        create: jest.fn((x: unknown) => x),
        save: jest.fn(),
      };
      const scopedApplications = {
        create: jest.fn((x: unknown) => x),
        save: jest.fn(),
      };
      scopedCards.save.mockResolvedValue({
        id: '5',
        publicId: 'card-1',
        providerKey: CardProviderKey.AXYS,
      });
      scopedApplications.save.mockRejectedValue(new Error('insert failed'));

      dataSource.transaction.mockImplementation(
        (run: (manager: EntityManager) => unknown) =>
          run({
            getRepository: (target: unknown) =>
              target === CardEntity ? scopedCards : scopedApplications,
          } as unknown as EntityManager),
      );

      await expect(useCase.execute(input())).rejects.toThrow('insert failed');

      expect(scopedCards.save).toHaveBeenCalledTimes(1);
      // The injected repositories are the ones outside the transaction.
      expect(cardRepository.save).not.toHaveBeenCalled();
      expect(applicationRepository.save).not.toHaveBeenCalled();
      // And nothing reached the issuer, so there is no application to strand.
      expect(adapter.issueCard).not.toHaveBeenCalled();
    });

    it('restarts when the server rolls the transaction back', async () => {
      // Recording the product puts a foreign key on `card_product`, so the
      // insert takes a shared lock the catalogue sync's withdrawal pass
      // contends with — and without a restart the server's choice of victim
      // reaches a partner as a failed issuance.
      const deadlock = new QueryFailedError(
        'INSERT',
        [],
        Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' }),
      );
      dataSource.transaction
        .mockRejectedValueOnce(deadlock)
        .mockImplementationOnce((run: (manager: EntityManager) => unknown) =>
          run({
            getRepository: (target: unknown) =>
              target === CardEntity ? cardRepository : applicationRepository,
          } as unknown as EntityManager),
        );

      await useCase.execute(input());

      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
      expect(adapter.issueCard).toHaveBeenCalledTimes(1);
    });

    it('gives up after the restart budget rather than retrying forever', async () => {
      const deadlock = new QueryFailedError(
        'INSERT',
        [],
        Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' }),
      );
      dataSource.transaction.mockRejectedValue(deadlock);

      await expect(useCase.execute(input())).rejects.toBe(deadlock);
      expect(dataSource.transaction).toHaveBeenCalledTimes(5);
    });
  });

  describe('the applicant sent to the adapter', () => {
    it('carries the stored cardholder details their application needs', async () => {
      await useCase.execute(input());

      expect(adapter.issueCard).toHaveBeenCalledWith(
        providerCardholderId,
        expect.objectContaining({
          applicant: {
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@example.com',
            callingCode: '44',
            cellNumber: '1234567890',
          },
        }),
        {},
        expect.any(String),
      );
    });

    it('omits the IP key when the cardholder was staged without one', async () => {
      // Optional in the partner's onboarding request and optional here — an
      // absent value is ordinary, never a sign that something was lost.
      await useCase.execute(input());

      expect(adapter.issueCard).toHaveBeenCalledWith(
        providerCardholderId,
        expect.objectContaining({
          applicant: {
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@example.com',
            callingCode: '44',
            cellNumber: '1234567890',
          },
        }),
        {},
        expect.any(String),
      );
    });

    it('carries the IP the partner observed when the row has one', async () => {
      cardholderRepository.findOne.mockResolvedValue({
        id: '1',
        publicId: 'ch-1',
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        userIp: '40.77.166.66',
        identityProvenance: { callingCode: '44', cellNumber: '1234567890' },
      });

      await useCase.execute(input());

      expect(adapter.issueCard).toHaveBeenCalledWith(
        providerCardholderId,
        expect.objectContaining({
          applicant: expect.objectContaining({
            userIp: '40.77.166.66',
          }) as unknown,
        }),
        {},
        expect.any(String),
      );
    });
  });
});
