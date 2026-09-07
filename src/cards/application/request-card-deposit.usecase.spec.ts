import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { CardCapability } from '../domain/card-capability.enum';
import { CardDepositStatus } from '../domain/card-deposit-status.enum';
import { CardDepositRequestResult } from '../domain/card-issuer.port';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardDepositEntity } from '../infrastructure/persistence/card-deposit.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import {
  CardDepositProduct,
  CardProductResolver,
} from './card-product-resolver';
import {
  RequestCardDepositInput,
  RequestCardDepositUseCase,
} from './request-card-deposit.usecase';

describe('RequestCardDepositUseCase', () => {
  let useCase: RequestCardDepositUseCase;
  let cardRepository: { findOne: jest.Mock };
  let depositRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
  };
  let cardProductResolver: { resolveForCard: jest.Mock };
  let cardIssuerRegistry: { resolve: jest.Mock };

  const adapter = {
    capabilities: new Set([CardCapability.DEPOSIT]),
    requestCardDeposit: jest.fn(),
  };

  /** An issuer funded by paying into an address, which declares no DEPOSIT. */
  const adapterWithoutDeposit = {
    capabilities: new Set([CardCapability.DEPOSIT_ADDRESS]),
    requestCardDeposit: jest.fn(),
  };

  const input = (
    overrides: Partial<RequestCardDepositInput> = {},
  ): RequestCardDepositInput => ({
    partnerId: 'partner-1',
    cardPublicId: 'card-1',
    requestId: 'partner-key-1',
    amount: '25.00',
    ...overrides,
  });

  const card = (overrides: Record<string, unknown> = {}) => ({
    id: '5',
    publicId: 'card-1',
    partnerId: 'partner-1',
    providerKey: CardProviderKey.HYPERCARD,
    providerCardId: 'hc-card-1',
    currency: 'USD',
    status: CardStatus.ACTIVE,
    ...overrides,
  });

  /**
   * Asserts against the last deposit row handed to `save`, which is the one
   * carrying the outcome.
   */
  const expectLastDeposit = (fields: Record<string, unknown>): void => {
    expect(depositRepository.save).toHaveBeenLastCalledWith(
      expect.objectContaining(fields),
    );
  };

  /** The shape MariaDB reports a unique-constraint violation with. */
  const duplicateKeyError = (): QueryFailedError => {
    const error = new QueryFailedError('INSERT', [], new Error('duplicate'));
    Object.assign(error, {
      code: 'ER_DUP_ENTRY',
      sqlMessage:
        "Duplicate entry 'HYPERCARD-partner-key-1' for key 'uq_card_deposit_provider_request'",
    });
    return error;
  };

  beforeEach(async () => {
    cardRepository = { findOne: jest.fn() };
    depositRepository = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => ({ ...(x as object), id: '11' })),
      findOne: jest.fn(),
    };
    cardProductResolver = { resolveForCard: jest.fn() };
    cardIssuerRegistry = { resolve: jest.fn(() => adapter) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RequestCardDepositUseCase,
        { provide: getRepositoryToken(CardEntity), useValue: cardRepository },
        {
          provide: getRepositoryToken(CardDepositEntity),
          useValue: depositRepository,
        },
        { provide: CardProductResolver, useValue: cardProductResolver },
        { provide: CardIssuerRegistry, useValue: cardIssuerRegistry },
      ],
    }).compile();

    useCase = module.get(RequestCardDepositUseCase);
    jest.clearAllMocks();
    cardIssuerRegistry.resolve.mockReturnValue(adapter);
    cardRepository.findOne.mockResolvedValue(card());
    // No application row by default, which is the shape of a card opened by an
    // issuer with no catalogue: there are no limits to check.
    cardProductResolver.resolveForCard.mockResolvedValue(null);
    adapter.requestCardDeposit.mockResolvedValue({
      providerDepositId: 'their-order-1',
      rawPayload: { order_no: 'their-order-1' },
    } satisfies CardDepositRequestResult);
  });

  it('records the deposit, calls the issuer, and reports it submitted', async () => {
    const result = await useCase.execute(input());

    expect(adapter.requestCardDeposit).toHaveBeenCalled();
    expectLastDeposit({
      status: CardDepositStatus.SUBMITTED,
      providerDepositId: 'their-order-1',
      responsePayload: { order_no: 'their-order-1' },
    });
    expect(result.status).toBe(CardDepositStatus.SUBMITTED);
    expect(result.requestId).toBe('partner-key-1');
    expect(result.amount).toBe('25.00');
    expect(result.currency).toBe('USD');
  });

  it('writes the row before the issuer is called', async () => {
    // Persistence-first is the whole shape of this use case: a crash between
    // the two leaves a record that money was asked for rather than losing it.
    const order: string[] = [];
    depositRepository.save.mockImplementation((x: unknown) => {
      order.push(`save:${(x as { status: string }).status}`);
      return { ...(x as object), id: '11' };
    });
    adapter.requestCardDeposit.mockImplementation(() => {
      order.push('provider');
      return Promise.resolve({ rawPayload: null });
    });

    await useCase.execute(input());

    expect(order).toEqual([
      `save:${CardDepositStatus.DRAFT}`,
      'provider',
      `save:${CardDepositStatus.SUBMITTED}`,
    ]);
  });

  it('sends the row’s own public id as the reference, never the partner’s key', async () => {
    // Their reference namespace is shared with the card applications, so a
    // partner-chosen key could collide with one and a settlement lookup would
    // answer about a stranger's row.
    await useCase.execute(input({ requestId: 'partner-key-1' }));

    expect(adapter.requestCardDeposit).toHaveBeenCalledWith(
      'hc-card-1',
      expect.objectContaining({
        amount: '25.00',
        currencyCode: 'USD',
      }),
      {},
    );
    const [, intent] = adapter.requestCardDeposit.mock.calls[0] as [
      string,
      { reference: string },
    ];
    expect(intent.reference).not.toBe('partner-key-1');
    expect(intent.reference).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('forwards a remark and omits the key when none was given', async () => {
    await useCase.execute(input({ remark: '  October top-up  ' }));
    expect(adapter.requestCardDeposit).toHaveBeenLastCalledWith(
      'hc-card-1',
      expect.objectContaining({ remark: 'October top-up' }),
      {},
    );

    await useCase.execute(input({ requestId: 'partner-key-2' }));
    const [, intent] = adapter.requestCardDeposit.mock.calls[1] as [
      string,
      Record<string, unknown>,
    ];
    expect(Object.keys(intent)).not.toContain('remark');
  });

  it('answers a replayed requestId with the deposit it collides with', async () => {
    depositRepository.save.mockRejectedValueOnce(duplicateKeyError());
    depositRepository.findOne.mockResolvedValueOnce({
      publicId: 'deposit-1',
      status: CardDepositStatus.SUBMITTED,
    });

    // One execution, two assertions: the mocks are one-shot, and a second call
    // would be testing the fixture rather than the behaviour. Both values are
    // asserted because naming the existing row is what closes the gap between a
    // partner's retry and the read they would otherwise have to make.
    const rejection = useCase.execute(input());

    await expect(rejection).rejects.toBeInstanceOf(ConflictException);
    await expect(rejection).rejects.toThrow(/deposit-1.*SUBMITTED/);
    expect(adapter.requestCardDeposit).not.toHaveBeenCalled();
  });

  it('does not name a colliding deposit that belongs to another partner', async () => {
    // The unique spans one issuer's whole namespace and this table has no
    // partner column, so two partners choosing the same key collide with each
    // other. The loser still learns the key is taken and learns nothing about
    // the winner's row.
    depositRepository.save.mockRejectedValueOnce(duplicateKeyError());
    depositRepository.findOne.mockResolvedValueOnce({
      publicId: 'someone-elses-deposit',
      cardId: '999',
      status: CardDepositStatus.SETTLED,
    });
    // The first call is this request's own card; the second is the ownership
    // check, which finds no card of this partner behind the colliding row.
    cardRepository.findOne
      .mockResolvedValueOnce(card())
      .mockResolvedValueOnce(null);

    const rejection = useCase.execute(input());

    await expect(rejection).rejects.toBeInstanceOf(ConflictException);
    await expect(rejection).rejects.not.toThrow(/someone-elses-deposit/);
    await expect(rejection).rejects.not.toThrow(/SETTLED/);
  });

  it('still refuses a replay when the colliding row cannot be read back', async () => {
    // The constraint is the guarantee; naming the existing row is a courtesy on
    // top of it, and losing the courtesy must not lose the refusal.
    depositRepository.save.mockRejectedValueOnce(duplicateKeyError());
    depositRepository.findOne.mockResolvedValueOnce(null);

    await expect(useCase.execute(input())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rethrows a duplicate on some other constraint rather than calling it a replay', async () => {
    const error = new QueryFailedError('INSERT', [], new Error('duplicate'));
    Object.assign(error, {
      code: 'ER_DUP_ENTRY',
      sqlMessage: "Duplicate entry 'x' for key 'some_other_index'",
    });
    depositRepository.save.mockRejectedValueOnce(error);

    await expect(useCase.execute(input())).rejects.toBe(error);
  });

  it('refuses a card that is not active, before anything is written', async () => {
    // Their own process puts recharge after activation, and a deposit against a
    // card that is not open yet is documented to become its *opening* deposit
    // instead — a different operation, silently.
    cardRepository.findOne.mockResolvedValue(
      card({ status: CardStatus.NOT_ACTIVATED }),
    );

    await expect(useCase.execute(input())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(depositRepository.save).not.toHaveBeenCalled();
    expect(adapter.requestCardDeposit).not.toHaveBeenCalled();
  });

  it('refuses a provider that does not declare the capability, writing no row', async () => {
    // The gate sits above the persistence-first write, so a refused call cannot
    // leave an orphaned draft deposit behind.
    cardIssuerRegistry.resolve.mockReturnValue(adapterWithoutDeposit);
    cardRepository.findOne.mockResolvedValue(
      card({ providerKey: CardProviderKey.AXYS }),
    );

    await expect(useCase.execute(input())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(useCase.execute(input())).rejects.toThrow(
      CardProviderKey.AXYS,
    );
    expect(depositRepository.save).not.toHaveBeenCalled();
  });

  it('answers a card belonging to another partner as not found', async () => {
    // The partner scoping is in the query, so "not yours" and "does not exist"
    // are deliberately the same answer.
    cardRepository.findOne.mockResolvedValue(null);

    await expect(
      useCase.execute(input({ partnerId: 'partner-2' })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers a card the issuer never opened as not found', async () => {
    cardRepository.findOne.mockResolvedValue(card({ providerCardId: null }));

    await expect(useCase.execute(input())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  describe('the currency', () => {
    it('is taken from the card when none was supplied', async () => {
      await useCase.execute(input());

      expectLastDeposit({ currencyCode: 'USD' });
    });

    it('is refused when it disagrees with the card', async () => {
      // Silently overriding a stated currency on a money movement would let a
      // partner believe they had deposited something they had not.
      await expect(
        useCase.execute(input({ currency: 'EUR' })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(depositRepository.save).not.toHaveBeenCalled();
    });

    it('is accepted when it agrees', async () => {
      await expect(
        useCase.execute(input({ currency: 'USD' })),
      ).resolves.toBeDefined();
    });
  });

  describe('the product’s per-transaction limits', () => {
    const withProduct = (limits: Partial<CardDepositProduct> = {}): void => {
      cardProductResolver.resolveForCard.mockResolvedValue({
        publicId: 'product-1',
        providerProductId: '52400002',
        currencyCode: 'USD',
        depositMinPerTransaction: '10',
        depositMaxPerTransaction: '100000',
        ...limits,
      });
    };

    it('are read from the product this card was opened under', async () => {
      // `card` carries no product reference at all, so the resolver is the only
      // route to the catalogue entry a card came from.
      withProduct();

      await useCase.execute(input({ amount: '25' }));

      // The provider goes with it: a product belonging to another one would
      // otherwise supply the handle sent to this issuer.
      expect(cardProductResolver.resolveForCard).toHaveBeenCalledWith(
        '5',
        CardProviderKey.HYPERCARD,
      );
      expect(adapter.requestCardDeposit).toHaveBeenCalled();
    });

    it('refuse an amount below the minimum, quoting it', async () => {
      withProduct();

      await expect(useCase.execute(input({ amount: '9.99' }))).rejects.toThrow(
        /10 USD/,
      );
      expect(depositRepository.save).not.toHaveBeenCalled();
    });

    it('refuse an amount above the maximum, quoting it', async () => {
      withProduct();

      await expect(
        useCase.execute(input({ amount: '100000.01' })),
      ).rejects.toThrow(/100000 USD/);
      expect(depositRepository.save).not.toHaveBeenCalled();
    });

    it('admit an amount exactly on a bound', async () => {
      // A float comparison is what gets a boundary wrong, with a partner's
      // money.
      withProduct();

      await expect(
        useCase.execute(input({ amount: '10.00' })),
      ).resolves.toBeDefined();
    });

    it('refuse a stored limit that cannot be read, rather than sending an unchecked amount', async () => {
      // The partner's half cannot reach this — the request pattern refuses
      // anything that is not a plain decimal — so it is always the catalogue
      // column, written by an adapter from an issuer's payload.
      withProduct({ depositMinPerTransaction: 'ten dollars' });

      await expect(useCase.execute(input())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(adapter.requestCardDeposit).not.toHaveBeenCalled();
    });

    it('are skipped when the card names no product', async () => {
      // An issuer with no catalogue at all is the ordinary case for this shape,
      // so it is a check that does not apply rather than one that fails.
      cardProductResolver.resolveForCard.mockResolvedValue(null);

      await expect(
        useCase.execute(input({ amount: '0.01' })),
      ).resolves.toBeDefined();
    });
  });

  describe('when the provider call fails', () => {
    it('records an issuer’s refusal as rejected, carrying their code', async () => {
      // The issuer read the request and declined it, so it was unambiguously
      // sent — and no deposit exists on their side to settle or refund.
      adapter.requestCardDeposit.mockRejectedValueOnce(
        new CardProviderConflictError(
          CardProviderKey.HYPERCARD,
          'A0006',
          'HyperCard card recharge failed (HTTP 200, code=A0006): balance is insufficient',
        ),
      );

      await expect(useCase.execute(input())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expectLastDeposit({
        status: CardDepositStatus.REJECTED,
        reasonCode: 'A0006',
      });
    });

    it('does not republish the provider’s own message', async () => {
      // That text is built around their wire content and carries their status,
      // their code and our internal operation name.
      const providerMessage =
        'HyperCard card recharge failed (HTTP 200, code=A0006): balance is insufficient';
      adapter.requestCardDeposit.mockRejectedValueOnce(
        new CardProviderConflictError(
          CardProviderKey.HYPERCARD,
          'A0006',
          providerMessage,
        ),
      );

      await expect(useCase.execute(input())).rejects.not.toThrow(
        providerMessage,
      );
      expect(depositRepository.save).not.toHaveBeenLastCalledWith(
        expect.objectContaining({ message: providerMessage }),
      );
    });

    it('records a call that never landed as a submission failure', async () => {
      adapter.requestCardDeposit.mockRejectedValueOnce(
        new Error('connection reset'),
      );

      await expect(useCase.execute(input())).rejects.toThrow(
        'connection reset',
      );
      expectLastDeposit({
        status: CardDepositStatus.SUBMISSION_FAILED,
        reasonCode: 'SUBMISSION_ERROR',
      });
    });

    it('never records a submission failure once the issuer has accepted', async () => {
      // The failure here is the *bookkeeping* write that follows a successful
      // call: the issuer holds the deposit and the funding account has been
      // debited.
      depositRepository.save
        .mockImplementationOnce((x: unknown) => ({
          ...(x as object),
          id: '11',
        }))
        .mockRejectedValueOnce(new Error('lock wait timeout'));

      await expect(useCase.execute(input())).rejects.toThrow(
        'lock wait timeout',
      );

      expect(adapter.requestCardDeposit).toHaveBeenCalled();
      expect(depositRepository.save).not.toHaveBeenCalledWith(
        expect.objectContaining({
          status: CardDepositStatus.SUBMISSION_FAILED,
        }),
      );
      expect(depositRepository.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: CardDepositStatus.REJECTED }),
      );
    });

    it('reports the provider’s failure even when the bookkeeping write also fails', async () => {
      // These writes run in exactly the circumstances that break writes, and
      // without the guard the caller hears about the symptom and never the
      // cause.
      adapter.requestCardDeposit.mockRejectedValueOnce(
        new Error('connection reset'),
      );
      depositRepository.save
        .mockImplementationOnce((x: unknown) => ({
          ...(x as object),
          id: '11',
        }))
        .mockRejectedValueOnce(new Error('database is gone'));

      await expect(useCase.execute(input())).rejects.toThrow(
        'connection reset',
      );
    });
  });
});
