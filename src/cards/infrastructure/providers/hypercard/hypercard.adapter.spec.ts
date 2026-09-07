import {
  constants,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  publicEncrypt,
} from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CardCapability } from '../../../domain/card-capability.enum';
import { CardDepositIntent } from '../../../domain/card-deposit-intent.model';
import {
  CardActivationIntent,
  CardIssuanceIntent,
} from '../../../domain/card-issuance-intent.model';
import {
  CardCallbackEvent,
  CardCallbackReading,
  CardIssuerPort,
  CardLifecycleOperationResult,
  CardOperationOutcome,
} from '../../../domain/card-issuer.port';
import { CardLifecycleOperation } from '../../../domain/card-lifecycle-operation.enum';
import { CardProductApplicationMode } from '../../../domain/card-product-application-mode.enum';
import { CardProviderKey } from '../../../domain/card-provider-key.enum';
import { CardActivationStatus } from '../../../domain/card-activation-status.enum';
import { CardStatus } from '../../../domain/card-status.enum';
import { CardType } from '../../../domain/card-type.enum';
import { CardProviderConflictError } from '../../../domain/card-provider-conflict.error';
import { CardProviderThrottledError } from '../../../domain/card-provider-throttled.error';
import { CardProviderIntentRejectedError } from '../../../domain/card-provider-intent-rejected.error';
import { CardProviderUnsupportedApplicationModeError } from '../../../domain/card-provider-unsupported-application-mode.error';
import { CardProviderUnsupportedOperationError } from '../../../domain/card-provider-unsupported-operation.error';
import { CardholderIntent } from '../../../domain/cardholder-intent.model';
import { CardholderStatus } from '../../../domain/cardholder-status.enum';
import {
  HyperCardCardDetailKeyPair,
  HyperCardCardDetailKeyService,
} from './hypercard-card-detail-key.service';
import {
  deriveHyperCardCardDetailPublicKey,
  HYPERCARD_CARD_DETAIL_MIN_MODULUS_BITS,
  loadHyperCardCardDetailKey,
} from './hypercard-card-detail.crypto';
import { HyperCardCardBalanceError } from './hypercard-card-balance.mapper';
import { HyperCardCardDetailError } from './hypercard-card-detail.mapper';
import { HyperCardMerchantBalanceError } from './hypercard-merchant-balance.mapper';
import { HyperCardHttpClient } from './hypercard-http-client.service';
import { HyperCardPlatformKeyService } from './hypercard-platform-key.service';
import { HyperCardSignatureService } from './hypercard-signature.service';
import { buildHyperCardCanonicalString } from './hypercard-signature.util';
import {
  assertHyperCardSuccess,
  HyperCardApiError,
} from './hypercard-response.util';
import { HyperCardTransactionError } from './hypercard-transaction.mapper';
import { HyperCardTradeNumberError } from './hypercard-trade-number.util';
import {
  HyperCardAdapter,
  HyperCardNotImplementedError,
  HyperCardResponseMismatchError,
} from './hypercard.adapter';

/** Every method name on the port — the non-method members excluded. */
type PortMethod = {
  [K in keyof CardIssuerPort]: CardIssuerPort[K] extends (
    ...args: never[]
  ) => unknown
    ? K
    : never;
}[keyof CardIssuerPort];

describe('HyperCardAdapter', () => {
  let adapter: HyperCardAdapter;
  let httpClient: {
    post: jest.Mock;
    postForAck: jest.Mock;
    postForOptionalData: jest.Mock;
  };

  /**
   * The card-detail keypair, generated once for the whole file. 4096 bits
   * because that is the floor their page states and the key service enforces;
   * generating one per case would pay for it a dozen times over.
   */
  let cardDetailKeyPair: HyperCardCardDetailKeyPair;

  /** Encrypts a plaintext the way their server is assumed to. */
  const encryptCardDetail = (plaintext: string): string =>
    publicEncrypt(
      {
        key: createPublicKey({
          key: Buffer.from(cardDetailKeyPair.publicKeyBase64, 'base64'),
          format: 'der',
          type: 'spki',
        }),
        padding: constants.RSA_PKCS1_PADDING,
      },
      Buffer.from(plaintext, 'utf8'),
    ).toString('base64');

  /**
   * Stands in for the issuer's own platform key. **We hold their public half
   * and not their private one**, so nothing here can produce a signature the
   * real verifier accepts — every callback case signs with a keypair the spec
   * made and points the adapter at its public half.
   */
  let platformPublicKeyPem: string;
  let platformPrivateKeyPem: string;
  let platformKeyService: { resolve: jest.Mock };

  beforeAll(() => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: HYPERCARD_CARD_DETAIL_MIN_MODULUS_BITS,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const key = loadHyperCardCardDetailKey(privateKey);
    cardDetailKeyPair = {
      privateKey: key,
      publicKeyBase64: deriveHyperCardCardDetailPublicKey(key),
    };

    // RSA-1024, which is what their signing scheme uses — not the 4096 above,
    // which is a different keypair for a different endpoint.
    const platform = generateKeyPairSync('rsa', {
      modulusLength: 1024,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    platformPublicKeyPem = platform.publicKey;
    platformPrivateKeyPem = platform.privateKey;
  });

  beforeEach(async () => {
    httpClient = {
      post: jest.fn(),
      postForAck: jest.fn(),
      postForOptionalData: jest.fn(),
    };
    platformKeyService = {
      resolve: jest.fn(() => Promise.resolve(platformPublicKeyPem)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HyperCardAdapter,
        { provide: HyperCardHttpClient, useValue: httpClient },
        {
          provide: HyperCardCardDetailKeyService,
          // A real keypair rather than a stub string, so the reveal cases below
          // run the real derivation and the real decryption — the wiring
          // between the request's public key and the answer's ciphertext is
          // precisely what a hand-built fixture would fail to exercise.
          useValue: { resolve: () => cardDetailKeyPair },
        },
        // The real signing service: the callback cases below sign a body with
        // a generated key and the verifier has to build the same canonical
        // string from it, which a stub would erase.
        HyperCardSignatureService,
        {
          provide: HyperCardPlatformKeyService,
          useValue: platformKeyService,
        },
      ],
    }).compile();

    adapter = module.get(HyperCardAdapter);
  });

  it('registers under the HYPERCARD provider key', () => {
    // The key must match the PAYMENTS_HYPERCARD_ env prefix exactly, or the
    // registry resolves nothing.
    expect(adapter.key).toBe(CardProviderKey.HYPERCARD);
  });

  it('declares exactly the capabilities whose methods it has built', () => {
    // Each change adds its own flag alongside the method it implements, so
    // this set and the implemented list below move together.
    expect(adapter.capabilities.has(CardCapability.PRODUCT_CATALOGUE)).toBe(
      true,
    );
    expect(adapter.capabilities.has(CardCapability.ONBOARD_CARDHOLDER)).toBe(
      true,
    );
    expect(adapter.capabilities.has(CardCapability.ISSUE_VIRTUAL)).toBe(true);
    expect(adapter.capabilities.has(CardCapability.APPLICATION_RESULT)).toBe(
      true,
    );
    expect(adapter.capabilities.has(CardCapability.ACTIVATE)).toBe(true);
    expect(adapter.capabilities.has(CardCapability.SENSITIVE_REVEAL)).toBe(
      true,
    );
    expect(adapter.capabilities.has(CardCapability.DEPOSIT)).toBe(true);
    expect(adapter.capabilities.has(CardCapability.BALANCE_READ)).toBe(true);
    expect(adapter.capabilities.has(CardCapability.TRANSACTIONS_READ)).toBe(
      true,
    );
    expect(adapter.capabilities.has(CardCapability.BLOCK)).toBe(true);
    // Its own flag beside BLOCK: one says the issuer freezes a card, the other
    // that the outcome arrives later and has to be fetched.
    expect(adapter.capabilities.has(CardCapability.OPERATION_RESULT)).toBe(
      true,
    );
    // The only flag whose call site is neither a route a partner reaches nor a
    // timer: it gates the address the issuer itself posts to.
    expect(adapter.capabilities.has(CardCapability.CALLBACK_EVENTS)).toBe(true);
    expect(adapter.capabilities.has(CardCapability.MERCHANT_BALANCE_READ)).toBe(
      true,
    );
    expect(adapter.capabilities.has(CardCapability.FUNDING_QUOTE)).toBe(true);
    expect(adapter.capabilities.size).toBe(14);
  });

  it('does not declare physical issuance', () => {
    // The issuance gate picks its capability by the requested form factor, so
    // this absence is what keeps a physical card refused with a 403 rather than
    // reaching an application that only ever opens a virtual one.
    expect(adapter.capabilities.has(CardCapability.ISSUE_PHYSICAL)).toBe(false);
  });

  // Every method on CardIssuerPort, split by whether it is built yet. Both
  // lists feed the completeness check below, so a method may be moved between
  // them but never dropped.
  const implementedMethods = [
    'listCardProducts',
    'onboardCardholder',
    'issueCard',
    'getCardApplicationResult',
    'activateCard',
    'revealSensitiveCardDetails',
    'quoteCardFunding',
    'requestCardDeposit',
    'getCardDepositResult',
    'getCardBalance',
    'getMerchantBalance',
    'getCardTransactions',
    'updateCardStatus',
    'getCardOperationResult',
    'readCallback',
    'callbackAck',
  ] satisfies readonly PortMethod[];

  const unimplementedMethods = [
    'getDepositAddresses',
    'updateCardPin',
  ] satisfies readonly PortMethod[];

  // A third state, and the reason it is not folded into the list above: no
  // later change implements these.
  const structurallyUnsupportedMethods = [
    'submitKyc',
    'queryCardholderStatus',
  ] satisfies readonly PortMethod[];

  // Accepts `never` and nothing else, so instantiating it with a non-empty
  // union is a compile error rather than a failing assertion.
  type AssertNever<T extends never> = T;
  type UncoveredPortMethods = Exclude<
    PortMethod,
    | (typeof implementedMethods)[number]
    | (typeof unimplementedMethods)[number]
    | (typeof structurallyUnsupportedMethods)[number]
  >;

  it('lists every method the port declares', () => {
    // Checked by the compiler, not by the expectation below: add a method to
    // CardIssuerPort without listing it above and `AssertNever` rejects it, so
    // ts-jest fails this suite with zero tests run.
    const uncovered: AssertNever<UncoveredPortMethods>[] = [];

    expect(uncovered).toHaveLength(0);
    for (const method of [
      ...implementedMethods,
      ...unimplementedMethods,
      ...structurallyUnsupportedMethods,
    ]) {
      expect(typeof adapter[method]).toBe('function');
    }
  });

  describe('listCardProducts', () => {
    /**
     * Their "Card config list" example row, trimmed to the mapped fields. The
     * untrimmed payload and the field-by-field assertions live in the mapper's
     * own spec; what this one proves is the wiring around it.
     */
    const theirRows = [
      {
        card_type_id: '40000002',
        card_type: '1',
        card_org: '1',
        card_sub_type: '1',
        apply_type: '2',
        activate_type: '2',
        card_coin: 'usd',
        card_fee: '100.00000000',
        annual_fee: '0.00000000',
        recharge_fee: '0.02800000',
        min_single_recharge_amount: '10.00000000',
        max_single_recharge_amount: '1000.00000000',
        max_recharge_amount: '100000.00000000',
        need_first_recharge: 1,
        min_first_recharge_amount: '100.00',
        can_recharge: 1,
        status: 1,
      },
    ];

    it('asks their card config endpoint for the whole catalogue', async () => {
      httpClient.postForOptionalData.mockResolvedValue(theirRows);

      await adapter.listCardProducts();

      // An empty body: their endpoint takes an optional product filter, and the
      // port deliberately carries no filter arguments. This is also the first
      // live exercise of the empty-body signing path.
      expect(httpClient.postForOptionalData).toHaveBeenCalledWith(
        'card config list',
        '/v5/openapi/card/list',
        {},
      );
    });

    it('goes through postForOptionalData rather than post', async () => {
      // A merchant with no products configured answers with no payload at all,
      // which is an empty catalogue rather than a failed call.
      httpClient.postForOptionalData.mockResolvedValue(theirRows);

      await adapter.listCardProducts();

      // The positive half matters as much as the negatives: without it, an
      // adapter refactored to call no transport method at all would keep this
      // test green.
      expect(httpClient.postForOptionalData).toHaveBeenCalledTimes(1);
      expect(httpClient.post).not.toHaveBeenCalled();
      expect(httpClient.postForAck).not.toHaveBeenCalled();
    });

    it('returns their catalogue normalised into the port vocabulary', async () => {
      httpClient.postForOptionalData.mockResolvedValue(theirRows);

      const listings = await adapter.listCardProducts();

      expect(listings).toHaveLength(1);
      expect(listings[0]?.product).toMatchObject({
        providerProductId: '40000002',
        displayName: 'Visa Virtual USD',
        cardType: CardType.VIRTUAL,
        currencyCode: 'USD',
        availableForIssuance: true,
      });
    });

    it('pairs each product with the row they sent', async () => {
      // Normalising is lossy by design, so the persistence layer needs the row
      // itself and cannot reconstruct it from the product.
      httpClient.postForOptionalData.mockResolvedValue(theirRows);

      const listings = await adapter.listCardProducts();

      expect(listings[0]?.rawPayload).toStrictEqual(theirRows[0]);
    });

    it.each([
      ['no payload', null],
      ['an empty array', []],
    ])('maps %s to an empty catalogue', async (_case, data) => {
      httpClient.postForOptionalData.mockResolvedValue(data);

      await expect(adapter.listCardProducts()).resolves.toStrictEqual([]);
    });

    it.each([
      ['an object', { card_type_id: '40000002' }],
      ['a bare string', 'ok'],
      ['a number', 7],
    ])(
      'treats %s where their page documents an array as an empty catalogue',
      async (_case, data) => {
        // Their envelope's type argument is a caller's expectation, not a
        // guarantee — `data` is an array on this endpoint and a bare string on
        // their cipherkey-app token endpoint. Iterating one of those would be
        // an untyped `is not iterable` crash rather than a mapping failure.
        httpClient.postForOptionalData.mockResolvedValue(data);

        await expect(adapter.listCardProducts()).resolves.toStrictEqual([]);
      },
    );

    it('lets a typed provider failure reach the caller untouched', async () => {
      // `HyperCardApiError`, not a bare Error: a use-case distinguishes their
      // failure codes on this type, so the new async method must not wrap or
      // swallow it.
      const failure = new HyperCardApiError(
        200,
        'A0002',
        'HyperCard card config list failed',
      );
      httpClient.postForOptionalData.mockRejectedValue(failure);

      await expect(adapter.listCardProducts()).rejects.toBe(failure);
    });
  });

  describe('onboardCardholder', () => {
    const intent: CardholderIntent = {
      publicId: '9f8c1e2a-4b7d-4c3e-8a51-6d2f0b9e7c14',
      partnerId: 'partner-1',
      providerKey: CardProviderKey.HYPERCARD,
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      phone: '+441234567890',
      dateOfBirth: '1815-12-10',
      residentialAddress: {
        addressLine1: '1 Main St',
        city: 'London',
        country: 'GB',
      },
      identityProvenance: {
        nationality: 'British',
        placeOfBirth: 'GBR',
        gender: 1,
        callingCode: '44',
        countryCallingCode: 'GB',
        cellNumber: '1234567890',
      },
    };

    it('returns the derived transaction number, approved', async () => {
      // `toStrictEqual` rather than `toMatchObject`, so the absence of `kycUrl`
      // is asserted too: HyperCard has no hosted KYC step to send anyone to,
      // and a key present-but-undefined would read as one that failed to
      // arrive.
      await expect(adapter.onboardCardholder(intent)).resolves.toStrictEqual({
        providerCardholderId: '9f8c1e2a4b7d4c3e8a516d2f0b9e7c14',
        status: CardholderStatus.APPROVED,
      });
    });

    it('makes no call to HyperCard', async () => {
      // The point of the method. Their application endpoints create the person
      // and the card together, so there is no cardholder to create here — this
      // stages one locally and mints the handle the application will carry.
      await adapter.onboardCardholder(intent);

      expect(httpClient.post).not.toHaveBeenCalled();
      expect(httpClient.postForAck).not.toHaveBeenCalled();
      expect(httpClient.postForOptionalData).not.toHaveBeenCalled();
    });

    it('returns the same transaction number on a repeat of the same request', async () => {
      const first = await adapter.onboardCardholder(intent);
      const second = await adapter.onboardCardholder(intent);

      expect(second.providerCardholderId).toBe(first.providerCardholderId);
    });

    it('returns a different transaction number for a different cardholder', async () => {
      const first = await adapter.onboardCardholder(intent);
      const second = await adapter.onboardCardholder({
        ...intent,
        publicId: '0d4a7b61-2c93-4f18-9e05-3a8b6c1d2e7f',
      });

      expect(second.providerCardholderId).not.toBe(first.providerCardholderId);
    });

    it('refuses a cardholder their application would not accept', async () => {
      // The field-by-field rules live in the guard's own spec; what this proves
      // is that the method consults it at all, and rejects rather than staging
      // a person whose application is going to fail later on a different call.
      await expect(
        adapter.onboardCardholder({ ...intent, lastName: "O'Brien" }),
      ).rejects.toBeInstanceOf(CardProviderIntentRejectedError);
    });

    it('makes no call to HyperCard when it refuses one', async () => {
      await expect(
        adapter.onboardCardholder({ ...intent, lastName: "O'Brien" }),
      ).rejects.toThrow();

      expect(httpClient.post).not.toHaveBeenCalled();
      expect(httpClient.postForAck).not.toHaveBeenCalled();
      expect(httpClient.postForOptionalData).not.toHaveBeenCalled();
    });

    it('rejects rather than throwing when no transaction number can be derived', () => {
      // Deriving validates its input, and this method is declared `Promise<T>`
      // — a synchronous throw would escape a caller's `.catch()`, which is the
      // same rule the unimplemented methods below follow.
      const returned = adapter.onboardCardholder({ ...intent, publicId: '' });

      expect(returned).toBeInstanceOf(Promise);
      return expect(returned).rejects.toBeInstanceOf(HyperCardTradeNumberError);
    });
  });

  describe('issueCard', () => {
    /** The cardholder reference the port hands every adapter. Unread here. */
    const cardholderReference = '9f8b7c6d5e4f4a3b2c1d0e9f8a7b6c5d';

    /** The card's own public id with its dashes stripped, which is what
     * addresses this application at the issuer. */
    const expectedTradeNumber = '11111111222243338444555555555555';

    /** Their "Application (Express)-v4" path, asserted as a literal — a
     * comparison against the resolver's own constant would pass however that
     * constant is edited, and a typo there makes the endpoint unreachable
     * rather than wrong. */
    const expressPath = '/v4/openapi/card/apply/quick';

    const intent = (
      overrides: Partial<CardIssuanceIntent> = {},
    ): CardIssuanceIntent => ({
      publicId: '11111111-2222-4333-8444-555555555555',
      cardholderPublicId: '9f8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d',
      providerKey: CardProviderKey.HYPERCARD,
      cardType: CardType.VIRTUAL,
      nameOnCard: 'ADA LOVELACE',
      applicant: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        callingCode: '44',
        cellNumber: '1234567890',
      },
      cardProduct: {
        providerProductId: '52400002',
        applicationMode: CardProductApplicationMode.NO_KYC,
      },
      ...overrides,
    });

    it('posts their Express application, keyed by the card rather than the cardholder', async () => {
      httpClient.postForAck.mockResolvedValue(undefined);

      await adapter.issueCard(cardholderReference, intent());

      expect(httpClient.postForAck).toHaveBeenCalledWith(
        'card application',
        expressPath,
        {
          mc_trade_no: expectedTradeNumber,
          base_info: {
            card_type_id: '52400002',
            email: 'ada@example.com',
            first_name: 'Ada',
            last_name: 'Lovelace',
            mobile: '1234567890',
            mobile_code: '44',
          },
        },
      );
    });

    it('derives the number from the card, not from the cardholder reference', async () => {
      // Their result lookup answers one outcome per transaction number, so a
      // number taken from the person answers a cardholder's second card with
      // the first one's outcome.
      httpClient.postForAck.mockResolvedValue(undefined);

      await adapter.issueCard(
        cardholderReference,
        intent({ publicId: '99999999-8888-4777-8666-555555555555' }),
      );

      expect(httpClient.postForAck).toHaveBeenCalledWith(
        'card application',
        expressPath,
        expect.objectContaining({
          mc_trade_no: '99999999888847778666555555555555',
        }),
      );
    });

    it('gives two cards of one cardholder two different numbers', async () => {
      httpClient.postForAck.mockResolvedValue(undefined);

      await adapter.issueCard(cardholderReference, intent());
      await adapter.issueCard(
        cardholderReference,
        intent({ publicId: '22222222-3333-4444-8555-666666666666' }),
      );

      const sent = (
        httpClient.postForAck.mock.calls as unknown as [
          string,
          string,
          { mc_trade_no: string },
        ][]
      ).map(([, , body]) => body.mc_trade_no);
      expect(new Set(sent).size).toBe(2);
    });

    it('refuses a card public id that is not a canonical UUID, before any call', async () => {
      // An invariant violation rather than partner input: the caller passes a
      // `randomUUID()` from the card table's insert hook, and the derivation is
      // collision-free only for that shape.
      await expect(
        adapter.issueCard(
          cardholderReference,
          intent({ publicId: 'not-a-uuid' }),
        ),
      ).rejects.toBeInstanceOf(HyperCardTradeNumberError);

      expect(httpClient.postForAck).not.toHaveBeenCalled();
    });

    it('goes through postForAck rather than a data-bearing call', async () => {
      // Their page documents a success as `{"code":"00000","msg":"ok"}` with no
      // `data` key at all, so requiring a payload would turn a documented
      // success into an error.
      httpClient.postForAck.mockResolvedValue(undefined);

      await adapter.issueCard(cardholderReference, intent());

      expect(httpClient.postForAck).toHaveBeenCalledTimes(1);
      expect(httpClient.post).not.toHaveBeenCalled();
      expect(httpClient.postForOptionalData).not.toHaveBeenCalled();
    });

    it('sends the opening deposit when one was committed', async () => {
      httpClient.postForAck.mockResolvedValue(undefined);

      await adapter.issueCard(
        cardholderReference,
        intent({ initialDepositAmount: '10' }),
      );

      expect(httpClient.postForAck).toHaveBeenCalledWith(
        'card application',
        expressPath,
        expect.objectContaining({
          base_info: expect.objectContaining({
            first_recharge_amount: '10',
          }) as unknown,
        }),
      );
    });

    it('omits the IP key entirely when the partner supplied none', async () => {
      // Not a blank string and not a null: their page marks the field
      // optional, and sending an explicit empty value invites a parameter
      // error over a field nobody had to send.
      httpClient.postForAck.mockResolvedValue(undefined);

      await adapter.issueCard(cardholderReference, intent());

      expect(httpClient.postForAck).toHaveBeenCalledWith(
        'card application',
        expressPath,
        expect.objectContaining({
          base_info: {
            card_type_id: '52400002',
            email: 'ada@example.com',
            first_name: 'Ada',
            last_name: 'Lovelace',
            mobile: '1234567890',
            mobile_code: '44',
          },
        }),
      );
    });

    it('sends the IP the partner observed when there is one', async () => {
      httpClient.postForAck.mockResolvedValue(undefined);

      await adapter.issueCard(
        cardholderReference,
        intent({
          applicant: { ...intent().applicant, userIp: '40.77.166.66' },
        }),
      );

      expect(httpClient.postForAck).toHaveBeenCalledWith(
        'card application',
        expressPath,
        expect.objectContaining({
          base_info: expect.objectContaining({
            user_ip: '40.77.166.66',
          }) as unknown,
        }),
      );
    });

    it('returns an acknowledgement with neither a card id nor a masked PAN', async () => {
      // Their application answers a result code and nothing else; the id and
      // the number arrive from their result lookup. Absent keys rather than
      // explicit undefined — on this port absent means "not known yet".
      httpClient.postForAck.mockResolvedValue(undefined);

      const result = await adapter.issueCard(cardholderReference, intent());

      expect(result).toEqual({ status: CardStatus.NOT_ACTIVATED });
      expect('providerCardId' in result).toBe(false);
      expect('maskedPan' in result).toBe(false);
    });

    it.each(
      Object.values(CardProductApplicationMode).filter(
        (mode) => mode !== CardProductApplicationMode.NO_KYC,
      ),
    )(
      'refuses a product applied for in %s mode, before any call',
      async (mode) => {
        // The mode comes from the stored catalogue rather than from the issuer,
        // so a product this integration does not apply for costs no call at all.
        await expect(
          adapter.issueCard(
            cardholderReference,
            intent({
              cardProduct: {
                providerProductId: '52400002',
                applicationMode: mode,
              },
            }),
          ),
        ).rejects.toBeInstanceOf(CardProviderUnsupportedApplicationModeError);

        expect(httpClient.postForAck).not.toHaveBeenCalled();
      },
    );

    it('refuses an intent carrying no product at all', async () => {
      // Unreachable through the issuance path, which resolves a product first.
      // Asserted anyway because the alternative is their parameter error
      // naming their own field, on a request that never carried ours.
      const { cardProduct, ...withoutProduct } = intent();
      void cardProduct;

      await expect(
        adapter.issueCard(cardholderReference, withoutProduct),
      ).rejects.toBeInstanceOf(CardProviderIntentRejectedError);

      expect(httpClient.postForAck).not.toHaveBeenCalled();
    });

    it('names the port field, never the request field, when it refuses', async () => {
      // Which field a partner supplied the reference in is the API layer's
      // vocabulary; an adapter spelling it out holds a name it cannot see
      // renamed. `cardProduct` is this method's own parameter, which the
      // adapter does own.
      const { cardProduct, ...withoutProduct } = intent();
      void cardProduct;

      await expect(
        adapter.issueCard(cardholderReference, withoutProduct),
      ).rejects.toMatchObject({ field: 'cardProduct' });
    });

    it('lets a state refusal through as the domain conflict type', async () => {
      // Translated by the response util from their envelope code, not here —
      // this asserts the adapter does not swallow or re-wrap it on the way out.
      const conflict = new CardProviderConflictError(
        CardProviderKey.HYPERCARD,
        'A0011',
        'HyperCard card application failed (HTTP 200, code=A0011): Card application not currently supported',
      );
      httpClient.postForAck.mockRejectedValue(conflict);

      await expect(
        adapter.issueCard(cardholderReference, intent()),
      ).rejects.toBe(conflict);
    });
  });

  describe('getCardApplicationResult', () => {
    /** What the application row stores — the card's `public_id`. */
    const requestId = '7e679210-e88f-4d6a-bbe2-1a2b39b0ceed';

    /** What their lookup is keyed on, re-derived from the reference above. */
    const tradeNumber = '7e679210e88f4d6abbe21a2b39b0ceed';

    /** Their "Application Result-v2" example response, `data` only. */
    const theirResult = (
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      mc_trade_no: tradeNumber,
      result: {
        card_type_id: '90000007',
        card_id: '6294677900000074589',
        card_number: '424904******4589',
        card_status: 9,
        fail_reason: '',
        fail_code: '',
        create_timestamp: 1685351195000,
        ...overrides,
      },
    });

    it('asks their result endpoint by the number re-derived from the stored reference', async () => {
      httpClient.post.mockResolvedValue(theirResult());

      await adapter.getCardApplicationResult(requestId);

      expect(httpClient.post).toHaveBeenCalledWith(
        'card application result',
        '/v2/openapi/card/apply/result',
        { mc_trade_no: tradeNumber },
      );
    });

    it('refuses a stored reference that is not a canonical UUID', async () => {
      // The row this reads holds a `public_id`; anything else means the number
      // sent at application time cannot be reproduced, and asking their lookup
      // with a guess would resolve the wrong card or none.
      await expect(
        adapter.getCardApplicationResult(tradeNumber),
      ).rejects.toBeInstanceOf(HyperCardTradeNumberError);

      expect(httpClient.post).not.toHaveBeenCalled();
    });

    it('resolves a card once their identifiers arrive', async () => {
      httpClient.post.mockResolvedValue(theirResult());

      await expect(
        adapter.getCardApplicationResult(requestId),
      ).resolves.toMatchObject({
        state: 'ISSUED',
        providerCardId: '6294677900000074589',
        maskedPan: '424904******4589',
        status: CardStatus.ACTIVE,
      });
    });

    /**
     * The behaviour a live application actually showed, and the reason this
     * adapter resolves on the identifier rather than on their status: it sat
     * at their reviewed-success code with both identifier fields empty across
     * repeated polls minutes apart, then filled them in later with the status
     * unchanged.
     */
    it('reports a reviewed-success application with no card id yet as pending', async () => {
      httpClient.post.mockResolvedValue(
        theirResult({ card_status: 3, card_id: '', card_number: '' }),
      );

      await expect(
        adapter.getCardApplicationResult(requestId),
      ).resolves.toMatchObject({ state: 'PENDING' });
    });

    it('resolves the same status once the card id lands', async () => {
      httpClient.post.mockResolvedValue(
        theirResult({
          card_status: 3,
          card_id: '30803710524000026680',
          card_number: '624673******6680',
        }),
      );

      await expect(
        adapter.getCardApplicationResult(requestId),
      ).resolves.toMatchObject({
        state: 'ISSUED',
        providerCardId: '30803710524000026680',
        maskedPan: '624673******6680',
      });
    });

    it('omits the masked number when only the card id has arrived', async () => {
      httpClient.post.mockResolvedValue(
        theirResult({
          card_status: 3,
          card_id: '30803710524000026680',
          card_number: '',
        }),
      );

      const outcome = await adapter.getCardApplicationResult(requestId);

      // Absent rather than empty: this port reads a missing key as "not known
      // yet", and an empty string would persist as a masked number of nothing.
      expect('maskedPan' in outcome).toBe(false);
    });

    /**
     * Their fail-code appendix is one table covering both stages of an opening
     * — `D` codes for the identity review, `E` codes for activation — so a
     * card that exists can still carry a fault.
     */
    it('carries a fault reported against a card that exists', async () => {
      httpClient.post.mockResolvedValue(
        theirResult({
          card_status: 8,
          fail_code: 'E0003',
          fail_reason:
            'Incorrect activation photo; finger is not covering the chip slot',
        }),
      );

      await expect(
        adapter.getCardApplicationResult(requestId),
      ).resolves.toMatchObject({
        state: 'ISSUED',
        providerCardId: '6294677900000074589',
        status: CardStatus.NOT_ACTIVATED,
        reasonCode: 'E0003',
        reason:
          'Incorrect activation photo; finger is not covering the chip slot',
      });
    });

    it('publishes the activation stage on the codes that are about one', async () => {
      httpClient.post.mockResolvedValue(theirResult({ card_status: 7 }));

      await expect(
        adapter.getCardApplicationResult(requestId),
      ).resolves.toMatchObject({
        state: 'ISSUED',
        status: CardStatus.NOT_ACTIVATED,
        activation: CardActivationStatus.PENDING,
      });
    });

    it('publishes a refused activation beside the code that explains it', async () => {
      httpClient.post.mockResolvedValue(
        theirResult({
          card_status: 12,
          fail_code: 'E0004',
          fail_reason:
            'Activation photo is in black and white; a color photo is required',
        }),
      );

      await expect(
        adapter.getCardApplicationResult(requestId),
      ).resolves.toMatchObject({
        state: 'ISSUED',
        status: CardStatus.NOT_ACTIVATED,
        activation: CardActivationStatus.FAILED,
        reasonCode: 'E0004',
      });
    });

    it('omits the activation stage on a code that is not about one', async () => {
      // Code 3 is the trap: they report it for a while after accepting an
      // activation, so an absent field has to read as "they said nothing"
      // rather than "nothing is outstanding".
      httpClient.post.mockResolvedValue(theirResult({ card_status: 3 }));

      const outcome = await adapter.getCardApplicationResult(requestId);

      expect('activation' in outcome).toBe(false);
    });

    it('omits the fault fields when they report none', async () => {
      // Their empty fields are empty strings rather than absent keys, and an
      // empty string here would persist as a failure reason of nothing.
      httpClient.post.mockResolvedValue(theirResult());

      const outcome = await adapter.getCardApplicationResult(requestId);

      expect('reasonCode' in outcome).toBe(false);
      expect('reason' in outcome).toBe(false);
    });

    it('reads their refusal as rejected, carrying their own code', async () => {
      httpClient.post.mockResolvedValue(
        theirResult({
          card_status: 4,
          card_id: '',
          card_number: '',
          fail_code: 'D0006',
          fail_reason: 'Incorrect name',
        }),
      );

      await expect(
        adapter.getCardApplicationResult(requestId),
      ).resolves.toMatchObject({
        state: 'REJECTED',
        reasonCode: 'D0006',
        reason: 'Incorrect name',
      });
    });

    it.each([
      // Their pre-apply, pending-payment and reviewing codes, plus the two
      // waiting states from their status appendix. None is an outcome.
      [0],
      [1],
      [2],
      [24],
      [30],
    ])('leaves their in-flight status %i pending', async (cardStatus) => {
      httpClient.post.mockResolvedValue(
        theirResult({ card_status: cardStatus, card_id: '', card_number: '' }),
      );

      await expect(
        adapter.getCardApplicationResult(requestId),
      ).resolves.toMatchObject({ state: 'PENDING' });
    });

    it('leaves a status it does not recognise pending rather than resolving it', async () => {
      // Their appendix leaves several codes undefined, so one they add later
      // arrives here with no change on our side. Waiting is the only direction
      // that can be recovered from.
      httpClient.post.mockResolvedValue(
        theirResult({ card_status: 99, card_id: '', card_number: '' }),
      );

      await expect(
        adapter.getCardApplicationResult(requestId),
      ).resolves.toMatchObject({ state: 'PENDING' });
    });

    it('keeps their response for replay', async () => {
      httpClient.post.mockResolvedValue(theirResult());

      const outcome = await adapter.getCardApplicationResult(requestId);

      expect(outcome).toMatchObject({
        rawPayload: expect.objectContaining({
          card_id: '6294677900000074589',
          card_status: 9,
          create_timestamp: 1685351195000,
        }) as Record<string, unknown>,
      });
    });

    /**
     * Confirmed live: their lookup for a number they are not holding answers
     * their parameter-error code with "does not exist" in the message.
     */
    it('reads their parameter error as a reference they do not hold', async () => {
      httpClient.post.mockRejectedValue(
        new HyperCardApiError(
          200,
          'A0003',
          `HyperCard card application result failed (HTTP 200, code=A0003): Parameter error:${tradeNumber} does not exist`,
        ),
      );

      await expect(
        adapter.getCardApplicationResult(requestId),
      ).resolves.toEqual({ state: 'UNKNOWN_REFERENCE' });
    });

    it('lets every other failure through', async () => {
      // Their "Card no existed" code rather than a conflict code: a conflict is
      // translated into the domain type by the response util and carries no
      // `code` property, so asserting one on it would pass vacuously.
      const failure = new HyperCardApiError(
        200,
        'A0004',
        'HyperCard card application result failed (HTTP 200, code=A0004): Card no existed',
      );
      httpClient.post.mockRejectedValue(failure);

      await expect(adapter.getCardApplicationResult(requestId)).rejects.toBe(
        failure,
      );
    });

    it('treats a success carrying no result object as pending, not as lost', async () => {
      // Undocumented, and the two absences mean opposite things: they are
      // holding the application, so there is something to come back for.
      httpClient.post.mockResolvedValue({ mc_trade_no: tradeNumber });

      await expect(
        adapter.getCardApplicationResult(requestId),
      ).resolves.toMatchObject({ state: 'PENDING' });
    });
  });

  describe('queryCardholderStatus', () => {
    it('refuses, because this issuer holds no person to report on', async () => {
      // The capability is undeclared, so the sync never reaches this. The
      // refusal is the backstop behind that gate.
      await expect(adapter.queryCardholderStatus()).rejects.toBeInstanceOf(
        CardProviderUnsupportedOperationError,
      );

      expect(httpClient.post).not.toHaveBeenCalled();
    });
  });

  describe('activateCard', () => {
    /**
     * Their "Activation" path, asserted as a literal for the reason the
     * application path is: a comparison against this file's own constant would
     * pass however that constant is edited, and a typo makes their endpoint
     * unreachable rather than wrong.
     */
    const activationPath = '/openapi/card/active';

    /** Raw base64 of a few bytes — enough to be the value under test, and
     * deliberately not a real photograph. Sandbox validates the picture's
     * format and not its subject, so no test here may depend on any particular
     * image being accepted anywhere. */
    const document = 'aGVsbG8td29ybGQ=';

    /** The card's own identifiers — everything else on this intent is optional
     * because issuers activate cards by different means. */
    const identifiers = {
      cardPublicId: '11111111-2222-4333-8444-555555555555',
      providerCardId: '30803710524000026680',
    } satisfies Partial<CardActivationIntent>;

    const intent = (
      overrides: Partial<CardActivationIntent> = {},
    ): CardActivationIntent => ({
      ...identifiers,
      activationDocument: document,
      ...overrides,
    });

    /** Built by omission rather than by overriding with undefined: under
     * `exactOptionalPropertyTypes` an absent optional and one set to undefined
     * are different things, and absent is what a request without the field
     * actually produces. */
    const intentWithoutDocument = (): CardActivationIntent => ({
      ...identifiers,
    });

    it('posts their activation endpoint with the card id and the document', async () => {
      httpClient.postForAck.mockResolvedValue(undefined);

      await adapter.activateCard(intent());

      expect(httpClient.postForAck).toHaveBeenCalledWith(
        'card activation',
        activationPath,
        { card_id: '30803710524000026680', file: document },
      );
    });

    it('goes through postForAck rather than a data-bearing call', async () => {
      // Their page documents a success as `{"code":"00000","msg":"ok"}` with no
      // `data` key, so requiring a payload would turn a documented success into
      // an error.
      httpClient.postForAck.mockResolvedValue(undefined);

      await adapter.activateCard(intent());

      expect(httpClient.postForAck).toHaveBeenCalledTimes(1);
      expect(httpClient.post).not.toHaveBeenCalled();
      expect(httpClient.postForOptionalData).not.toHaveBeenCalled();
    });

    it('sends none of the printed card details their endpoint has no field for', async () => {
      httpClient.postForAck.mockResolvedValue(undefined);

      await adapter.activateCard(
        intent({
          pan: '4249040000004589',
          expiryMonth: 12,
          expiryYear: 2030,
          cvv: '123',
          pin: '1234',
        }),
      );

      // Their activation page publishes exactly two fields. A partner porting
      // from an issuer that wants a PAN may well send one anyway, and it must
      // not reach a request that has nowhere to put it.
      expect(httpClient.postForAck).toHaveBeenNthCalledWith(
        1,
        'card activation',
        activationPath,
        { card_id: '30803710524000026680', file: document },
      );
    });

    it('reports the card still not activated, because their call only acknowledges', async () => {
      // The card is at their activating code when this returns and reaches
      // their activated one shortly after, unattended.
      httpClient.postForAck.mockResolvedValue(undefined);

      await expect(adapter.activateCard(intent())).resolves.toEqual({
        status: CardStatus.NOT_ACTIVATED,
      });
    });

    it('refuses an activation with no document, naming our own field', async () => {
      await expect(
        adapter.activateCard(intentWithoutDocument()),
      ).rejects.toBeInstanceOf(CardProviderIntentRejectedError);
      await expect(
        adapter.activateCard(intentWithoutDocument()),
      ).rejects.toMatchObject({
        providerKey: CardProviderKey.HYPERCARD,
        field: 'activationDocument',
      });
    });

    it('makes no call when it refuses one', async () => {
      // Refused before anything is sent, so a request that could never succeed
      // costs no round trip.
      await expect(
        adapter.activateCard(intentWithoutDocument()),
      ).rejects.toThrow();

      expect(httpClient.postForAck).not.toHaveBeenCalled();
    });

    it('turns their parameter error into a refusal naming the document', async () => {
      // Their parameter error is generic across their API, but this request
      // carries two values: the card id, which came from them, and the
      // document, which is the partner's.
      httpClient.postForAck.mockRejectedValue(
        new HyperCardApiError(200, 'A0003', 'active_doc ...'),
      );

      await expect(adapter.activateCard(intent())).rejects.toMatchObject({
        name: 'CardProviderIntentRejectedError',
        field: 'activationDocument',
      });
    });

    it('does not republish their wording, and keeps it on the cause', async () => {
      // Their text names their own field rather than ours and is remote content
      // of unknown shape, so it stays out of the composed message a partner
      // reads — and stays reachable for a log.
      const theirFailure = new HyperCardApiError(
        200,
        'A0003',
        'active_doc Unable to determine the picture type',
      );
      httpClient.postForAck.mockRejectedValue(theirFailure);

      const raised = await adapter
        .activateCard(intent())
        .catch((e: unknown) => e);

      expect((raised as Error).message).not.toContain('active_doc');
      expect((raised as Error).cause).toBe(theirFailure);
    });

    it('never writes the document to a log, however they word their refusal', async () => {
      // Their messages echo request input — their parameter error on the
      // application-result lookup quotes the value it was given straight back.
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const bulky = 'B'.repeat(5000);
      httpClient.postForAck.mockRejectedValue(
        new HyperCardApiError(200, 'A0003', `active_doc bad: ${bulky}`),
      );

      await expect(
        adapter.activateCard(intent({ activationDocument: bulky })),
      ).rejects.toThrow();

      const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).not.toContain(bulky);
      expect(logged).toContain('[document]');
      // Trimmed as well as redacted: their text is remote content of unbounded
      // length, and a log line is not where that should be discovered.
      expect(logged.length).toBeLessThan(500);
      warn.mockRestore();
    });

    it('never puts the document in the refusal it raises', async () => {
      // It passes through memory once and must reach no log line, no error
      // message and no persisted payload.
      httpClient.postForAck.mockRejectedValue(
        new HyperCardApiError(200, 'A0003', 'active_doc ...'),
      );

      const raised = await adapter
        .activateCard(intent())
        .catch((e: unknown) => e);

      expect((raised as Error).message).not.toContain(document);
    });

    it('lets a state refusal reach the caller as the domain conflict', async () => {
      // Already activated, already cancelled, a duplicate request — the caller
      // answers this as a 409, and it must not be reshaped here.
      const conflict = new CardProviderConflictError(
        CardProviderKey.HYPERCARD,
        'A0005',
        'HyperCard card activation failed (HTTP 200, code=A0005): Duplicated request',
      );
      httpClient.postForAck.mockRejectedValue(conflict);

      await expect(adapter.activateCard(intent())).rejects.toBe(conflict);
    });
  });

  describe('revealSensitiveCardDetails', () => {
    const PROVIDER_CARD_ID = '30806984524000022826';

    /** Their own documented virtual-card plaintext. */
    const THEIR_VIRTUAL_PAYLOAD =
      '{"cvv":"123","card_number":"1001022400001101","expire":"04/2025"}';

    /**
     * Their response, defaulting to a well-formed one for the account we hold
     * — obtain way 0, virtual card — with the public key echoed as their page
     * says it is.
     */
    const theirResponse = (
      overrides: Record<string, unknown> = {},
      plaintext = THEIR_VIRTUAL_PAYLOAD,
    ): Record<string, unknown> => ({
      pub_key: cardDetailKeyPair.publicKeyBase64,
      card_id: PROVIDER_CARD_ID,
      encoded_card_detail: encryptCardDetail(plaintext),
      card_detail_obtain_way: 0,
      card_type: 1,
      ...overrides,
    });

    it('refuses an answer whose echoed card id is not the one it asked about', async () => {
      // The highest-consequence check on this route: their sandbox answers with
      // one canned detail for every card, so a response about a different card
      // is a shape that genuinely occurs — and unguarded it would hand a partner
      // another cardholder's number.
      httpClient.post.mockResolvedValueOnce(
        theirResponse({ card_id: '30830869524000023908' }),
      );

      await expect(
        adapter.revealSensitiveCardDetails(PROVIDER_CARD_ID),
      ).rejects.toThrow(/echoed a different card id/);
    });

    it('refuses a card id echoed as a JSON number, naming precision as the reason', async () => {
      // Their ids are twenty digits, past double precision, so a numeric echo
      // was already corrupted by `JSON.parse` before the adapter saw it:
      // `Number('30806984524000022826')` is not that number.
      expect(String(Number(PROVIDER_CARD_ID))).not.toBe(PROVIDER_CARD_ID);

      httpClient.post.mockResolvedValueOnce(
        theirResponse({ card_id: Number(PROVIDER_CARD_ID) }),
      );

      await expect(
        adapter.revealSensitiveCardDetails(PROVIDER_CARD_ID),
      ).rejects.toThrow(/lost precision/);
    });

    it('tolerates a line-wrapped echo of its own public key', async () => {
      // Base64 carries no significant whitespace, and their merchant docs ask
      // integrators to strip newlines from a key — so a wrapped echo is a shape
      // they plausibly produce, and comparing raw would fail every reveal while
      // reporting a key mismatch that had not happened.
      const wrapped = cardDetailKeyPair.publicKeyBase64.replace(
        /(.{64})/g,
        '$1\n',
      );
      httpClient.post.mockResolvedValueOnce(
        theirResponse({ pub_key: wrapped }),
      );

      await expect(
        adapter.revealSensitiveCardDetails(PROVIDER_CARD_ID),
      ).resolves.toBeDefined();
    });

    it('sends the card id and our derived public key to their detail endpoint', async () => {
      httpClient.post.mockResolvedValueOnce(theirResponse());

      await adapter.revealSensitiveCardDetails(PROVIDER_CARD_ID);

      // An exact object rather than `objectContaining`, so an extra key fails
      // too — their endpoint takes exactly these two.
      expect(httpClient.post).toHaveBeenCalledWith(
        'bank card detail',
        '/v2/openapi/card/bank/details',
        {
          card_id: PROVIDER_CARD_ID,
          pub_key: cardDetailKeyPair.publicKeyBase64,
        },
      );
    });

    it('decrypts their answer into the full set', async () => {
      httpClient.post.mockResolvedValueOnce(theirResponse());

      const details =
        await adapter.revealSensitiveCardDetails(PROVIDER_CARD_ID);

      expect(details.expose()).toEqual({
        kind: 'FULL',
        pan: '1001022400001101',
        maskedPan: '100102******1101',
        cvv: '123',
        expiryMonth: 4,
        expiryYear: 2025,
      });
    });

    it('refuses an answer whose echoed public key is not the one it sent', async () => {
      // Their page says the response carries the same `pub_key` as the request,
      // which is what makes a mismatch detectable rather than surfacing three
      // steps later as an unreadable payload.
      httpClient.post.mockResolvedValueOnce(
        theirResponse({ pub_key: 'some-other-key' }),
      );

      await expect(
        adapter.revealSensitiveCardDetails(PROVIDER_CARD_ID),
      ).rejects.toThrow(/echoed a different public key/);
    });

    it('refuses an answer carrying no encrypted detail', async () => {
      httpClient.post.mockResolvedValueOnce(
        theirResponse({ encoded_card_detail: undefined }),
      );

      await expect(
        adapter.revealSensitiveCardDetails(PROVIDER_CARD_ID),
      ).rejects.toThrow(/no encoded_card_detail/);
    });

    it('does not swallow a decryption that produced something unreadable', async () => {
      // A padding mismatch, or a key no larger than ours, does not raise at
      // the decrypt — OpenSSL implicitly rejects a bad PKCS#1 v1.5 decryption
      // by returning pseudorandom bytes — so this is the shape a real mismatch
      // usually takes, and it has to reach the caller rather than degrade into
      // a partial detail.
      httpClient.post.mockResolvedValueOnce(
        theirResponse({
          encoded_card_detail:
            Buffer.from('not a ciphertext').toString('base64'),
        }),
      );

      await expect(
        adapter.revealSensitiveCardDetails(PROVIDER_CARD_ID),
      ).rejects.toBeInstanceOf(HyperCardCardDetailError);
    });

    it('refuses an obtain way it does not recognise rather than guessing', async () => {
      httpClient.post.mockResolvedValueOnce(
        theirResponse({ card_detail_obtain_way: 7 }),
      );

      await expect(
        adapter.revealSensitiveCardDetails(PROVIDER_CARD_ID),
      ).rejects.toThrow(/unrecognised card_detail_obtain_way "7"/);
    });

    it('branches on their response and never on a stored product', async () => {
      // The same card id, answered two different ways by the issuer. Nothing
      // about the card or its product changed — which is the point: a product's
      // obtain way is a setting on their side that can change without a deploy
      // of ours, so the response is the only thing a decrypt may be driven from.
      httpClient.post.mockResolvedValueOnce(
        theirResponse(
          { card_detail_obtain_way: 2 },
          '{"cvv":"please check in email","card_number":"1001022400001101","expire":"please check in email"}',
        ),
      );

      const details =
        await adapter.revealSensitiveCardDetails(PROVIDER_CARD_ID);

      expect(details.expose()).toEqual({
        kind: 'CARDHOLDER_DIRECT',
        pan: '1001022400001101',
        maskedPan: '100102******1101',
      });
    });

    it('lets a provider conflict through for its caller to map', async () => {
      const conflict = new CardProviderConflictError(
        CardProviderKey.HYPERCARD,
        'A0005',
        'Duplicated request',
      );
      httpClient.post.mockRejectedValueOnce(conflict);

      await expect(
        adapter.revealSensitiveCardDetails(PROVIDER_CARD_ID),
      ).rejects.toBe(conflict);
    });

    it('logs nothing at all on a successful read', async () => {
      // Neither the ciphertext, the plaintext nor the key may reach a log line,
      // and the cheapest way to guarantee that is to write no log line.
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      httpClient.post.mockResolvedValueOnce(theirResponse());

      await adapter.revealSensitiveCardDetails(PROVIDER_CARD_ID);

      expect(warn).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      warn.mockRestore();
      log.mockRestore();
    });
  });

  describe('quoteCardFunding', () => {
    const PROVIDER_PRODUCT_ID = '40000002';

    /** Their "Estimate crypto" page's own example response, verbatim. */
    const theirResponse = () => ({
      card_coin: 'usd',
      coin_exchange_usd_rate: '1',
      currency_amount: '188',
      currency_exchange_usd_rate: '1',
      pay_coin: 'usdt',
      real_recharge_amount: '188',
      recharge_amount: '188.88',
      recharge_fee_amount: '0.88',
      recharge_fee_usdt_amount: '0.88',
    });

    const quote = (intentCurrency = 'USD') =>
      adapter.quoteCardFunding(PROVIDER_PRODUCT_ID, {
        depositAmount: '188',
        currencyCode: intentCurrency,
      });

    it('asks their estimate endpoint for the product, coin and fiat amount', async () => {
      httpClient.post.mockResolvedValue(theirResponse());

      await quote();

      expect(httpClient.post).toHaveBeenCalledWith(
        'card funding estimate',
        '/openapi/card/estimation/crypto',
        {
          card_type_id: PROVIDER_PRODUCT_ID,
          pay_coin: 'usdt',
          // Fiat on the way in, coin on the way back.
          recharge_amount: '188',
        },
      );
      expect(httpClient.postForOptionalData).not.toHaveBeenCalled();
    });

    it('answers the cost in the coin and the credit in the fiat', async () => {
      httpClient.post.mockResolvedValue(theirResponse());

      const result = await quote();

      expect(result.cost).toEqual({ amount: '188.88', currencyCode: 'USDT' });
      expect(result.fee).toEqual({ amount: '0.88', currencyCode: 'USDT' });
      expect(result.credited).toEqual({ amount: '188', currencyCode: 'USD' });
      expect(Date.parse(result.quotedAt)).not.toBeNaN();
    });

    it('refuses a cost priced in a coin other than the one it asked for', async () => {
      httpClient.post.mockResolvedValue({
        ...theirResponse(),
        pay_coin: 'btc',
      });

      await expect(quote()).rejects.toThrow(/priced a deposit in btc/);
    });

    it('warns rather than refusing when the quoted currency is not the product’s', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      httpClient.post.mockResolvedValue(theirResponse());

      const result = await quote('EUR');

      expect(result.credited.currencyCode).toBe('USD');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('priced product 40000002 in USD'),
      );
      warn.mockRestore();
    });

    it('translates their card-does-not-support-recharging code to a conflict', async () => {
      httpClient.post.mockImplementation(() =>
        assertHyperCardSuccess('card funding estimate', 200, {
          code: 'A0010',
          msg: 'This card does not support recharging',
        }),
      );

      await expect(quote()).rejects.toBeInstanceOf(CardProviderConflictError);
    });

    it('turns their parameter error into a refusal a partner can act on', async () => {
      httpClient.post.mockImplementation(() =>
        assertHyperCardSuccess('card funding estimate', 200, {
          code: 'A0003',
          msg: 'Parameter error',
        }),
      );

      // An adapter-local error here would reach a partner as an anonymous fault.
      await expect(quote()).rejects.toBeInstanceOf(
        CardProviderIntentRejectedError,
      );
      await expect(quote()).rejects.toThrow(/initialDepositAmount/);
    });

    it('does not translate a refusal it cannot account for', async () => {
      httpClient.post.mockImplementation(() =>
        assertHyperCardSuccess('card funding estimate', 200, {
          code: 'A0004',
          msg: 'Card no existed',
        }),
      );

      await expect(quote()).rejects.toBeInstanceOf(HyperCardApiError);
    });

    it('says so when they price without echoing the coin', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const withoutEcho: Record<string, unknown> = theirResponse();
      delete withoutEcho.pay_coin;
      httpClient.post.mockResolvedValue(withoutEcho);

      const result = await quote();

      expect(result.cost.currencyCode).toBe('USDT');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('without echoing pay_coin'),
      );
      warn.mockRestore();
    });

    it('declares the capability that gates it', () => {
      expect(adapter.capabilities.has(CardCapability.FUNDING_QUOTE)).toBe(true);
    });
  });

  describe('requestCardDeposit', () => {
    const PROVIDER_CARD_ID = '00003454323400000028888';
    /** A canonical UUID, which is what the port's reference has to be. */
    const DEPOSIT_PUBLIC_ID = '48d27417-47a4-4932-a3fe-b2201a2b39b0';
    const DEPOSIT_TRADE_NUMBER = '48d2741747a44932a3feb2201a2b39b0';

    /** Their "Recharge" page's own example response, verbatim. */
    const theirResponse = () => ({
      card_coin: 'usd',
      coin_exchange_usd_rate: '1',
      currency_amount: '188',
      currency_exchange_usd_rate: '1.12',
      order_no: '202211231505292302221643837177',
      pay_coin: 'usdt',
      real_recharge_amount: '188',
      recharge_amount: '188.88',
      recharge_fee_amount: '0.88',
      recharge_fee_usdt_amount: '0.88',
    });

    const intent = (overrides: Partial<CardDepositIntent> = {}) => ({
      reference: DEPOSIT_PUBLIC_ID,
      amount: '188',
      currencyCode: 'USD',
      ...overrides,
    });

    it('sends the fiat amount, their payment coin and the derived trade number', async () => {
      httpClient.postForOptionalData.mockResolvedValueOnce(theirResponse());

      await adapter.requestCardDeposit(PROVIDER_CARD_ID, intent());

      // An exact object rather than `objectContaining`: this also fails on an
      // extra key, which is what proves the remark is absent rather than sent
      // empty.
      expect(httpClient.postForOptionalData).toHaveBeenCalledWith(
        'card recharge',
        '/openapi/card/recharge',
        {
          card_id: PROVIDER_CARD_ID,
          mc_trade_no: DEPOSIT_TRADE_NUMBER,
          pay_coin: 'usdt',
          // Their request field is the fiat going into the card, which is
          // exactly what the intent carries. The response's field of the same
          // name is a different quantity — see the case below.
          recharge_amount: '188',
        },
      );
    });

    it('sends a remark when one was supplied', async () => {
      httpClient.postForOptionalData.mockResolvedValueOnce(theirResponse());

      await adapter.requestCardDeposit(
        PROVIDER_CARD_ID,
        intent({ remark: 'Any remark' }),
      );

      expect(httpClient.postForOptionalData).toHaveBeenCalledWith(
        'card recharge',
        '/openapi/card/recharge',
        expect.objectContaining({ remark: 'Any remark' }),
      );
    });

    it('takes their order number as the deposit id and keeps the payload whole', async () => {
      httpClient.postForOptionalData.mockResolvedValueOnce(theirResponse());

      const result = await adapter.requestCardDeposit(
        PROVIDER_CARD_ID,
        intent(),
      );

      expect(result.providerDepositId).toBe('202211231505292302221643837177');
      expect(result.rawPayload).toEqual(theirResponse());
    });

    it('maps none of their amounts onto the result', async () => {
      // The other half of the trap.
      httpClient.postForOptionalData.mockResolvedValueOnce(theirResponse());

      const result = await adapter.requestCardDeposit(
        PROVIDER_CARD_ID,
        intent(),
      );

      expect(Object.keys(result).sort()).toEqual([
        'providerDepositId',
        'rawPayload',
      ]);
    });

    it('ignores an order number they send as a JSON number', async () => {
      // Their parameter tables and their example payloads disagree about which
      // fields are strings, and their sandbox has contradicted both — but an
      // identifier is not a field to coerce.
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      httpClient.postForOptionalData.mockResolvedValueOnce({
        ...theirResponse(),
        order_no: Number('202211231505292302221643837177'),
      });

      const result = await adapter.requestCardDeposit(
        PROVIDER_CARD_ID,
        intent(),
      );

      expect(result.providerDepositId).toBeUndefined();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('accepts their documented empty payload without an identifier', async () => {
      // Their page: a card in pre-apply state "will return empty data field on
      // respond". The request was still accepted, so this is not an error — the
      // settlement lookup is keyed on the reference we sent rather than on
      // anything returned here.
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      httpClient.postForOptionalData.mockResolvedValueOnce(null);

      const result = await adapter.requestCardDeposit(
        PROVIDER_CARD_ID,
        intent(),
      );

      expect(result).toEqual({ rawPayload: null });
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('warns when they credit a currency the card is not denominated in', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      httpClient.postForOptionalData.mockResolvedValueOnce({
        ...theirResponse(),
        card_coin: 'eur',
      });

      // A warning and never a refusal: the money has already been asked for by
      // the time this is reachable.
      await expect(
        adapter.requestCardDeposit(PROVIDER_CARD_ID, intent()),
      ).resolves.toBeDefined();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('refuses a reference that is not a canonical UUID', async () => {
      // The derivation's injectivity is what keeps a deposit from colliding
      // with a card application in the issuer's shared reference namespace, and
      // it only holds for canonical UUIDs.
      await expect(
        adapter.requestCardDeposit(
          PROVIDER_CARD_ID,
          intent({ reference: 'not-a-uuid' }),
        ),
      ).rejects.toBeInstanceOf(HyperCardTradeNumberError);
      expect(httpClient.postForOptionalData).not.toHaveBeenCalled();
    });

    it.each([
      ['A0006', 'balance is insufficient'],
      ['A0010', 'This card does not support recharging'],
    ])('surfaces their %s as a provider conflict', async (code, message) => {
      // Asserted on `providerCode`, not `code`: the conflict translation
      // produces a domain error that has no `code` property at all, so a
      // spec matching `{ code }` would pass against anything.
      httpClient.postForOptionalData.mockRejectedValueOnce(
        new CardProviderConflictError(
          CardProviderKey.HYPERCARD,
          code,
          `HyperCard card recharge failed (HTTP 200, code=${code}): ${message}`,
        ),
      );

      await expect(
        adapter.requestCardDeposit(PROVIDER_CARD_ID, intent()),
      ).rejects.toMatchObject({ providerCode: code });
    });

    it('leaves their card-not-found code as a plain API error', async () => {
      // Deliberately not in the conflict set — a card they do not hold is a
      // not-found rather than a state refusal, and it keeps `code` where a
      // conflict would not.
      httpClient.postForOptionalData.mockRejectedValueOnce(
        new HyperCardApiError(
          200,
          'A0004',
          'HyperCard card recharge failed (HTTP 200, code=A0004): Card no existed',
        ),
      );

      await expect(
        adapter.requestCardDeposit(PROVIDER_CARD_ID, intent()),
      ).rejects.toMatchObject({ code: 'A0004' });
    });
  });

  describe('getCardDepositResult', () => {
    const PROVIDER_CARD_ID = '00003454323400000028888';
    /** A canonical UUID, which is what the port's reference has to be. */
    const DEPOSIT_PUBLIC_ID = '48d27417-47a4-4932-a3fe-b2201a2b39b0';
    const DEPOSIT_TRADE_NUMBER = '48d2741747a44932a3feb2201a2b39b0';

    /**
     * Their "Recharge Query" page's own example payload, verbatim apart from
     * the status each case sets.
     */
    const theirPayload = (overrides: Record<string, unknown> = {}) => ({
      order_no: '20250719104417971096',
      recharge_amount: '102.71614508',
      pay_coin: 'usdt',
      recharge_fee_amount: '2.59209940',
      recharge_fee_usdt_amount: '0.00000000',
      real_recharge_amount: '100.12404568',
      currency_amount: '100.00000000',
      card_coin: 'usd',
      coin_exchange_usd_rate: '0.99876108',
      currency_exchange_usd_rate: '1.00000000',
      card_id: PROVIDER_CARD_ID,
      mc_trade_no: DEPOSIT_TRADE_NUMBER,
      status: 0,
      fail_reason: '',
      ...overrides,
    });

    const lookUp = () =>
      adapter.getCardDepositResult(PROVIDER_CARD_ID, DEPOSIT_PUBLIC_ID);

    it('asks their recharge query by the card and the derived trade number', async () => {
      httpClient.postForOptionalData.mockResolvedValueOnce(theirPayload());

      await lookUp();

      // Their lookup is keyed on the pair, so both halves are asserted. An
      // exact object also fails on an extra key.
      expect(httpClient.postForOptionalData).toHaveBeenCalledWith(
        'card recharge query',
        '/openapi/card/recharge/query',
        { card_id: PROVIDER_CARD_ID, mc_trade_no: DEPOSIT_TRADE_NUMBER },
      );
    });

    it('reads their pending status as no outcome yet', async () => {
      httpClient.postForOptionalData.mockResolvedValueOnce(theirPayload());

      await expect(lookUp()).resolves.toMatchObject({ state: 'PENDING' });
    });

    it('takes the fiat figure as the credited amount, never the coin one', async () => {
      // The trap, asserted in both directions. Their `recharge_amount` here is
      // denominated in the payment coin, so a mapping that echoed it would
      // change the unit *and* the currency of a stored money value with nothing
      // in the payload to make it look wrong.
      httpClient.postForOptionalData.mockResolvedValueOnce(
        theirPayload({ status: 1 }),
      );

      const outcome = await lookUp();

      expect(outcome).toMatchObject({
        state: 'SETTLED',
        creditedAmount: '100.00000000',
        creditedCurrencyCode: 'usd',
        providerDepositId: '20250719104417971096',
      });
      // The raw payload is excluded before this check, deliberately: the coin
      // figure is *supposed* to survive there, since that column is retained
      // for replay. What must not happen is a mapped field carrying it.
      const mapped: Record<string, unknown> = {
        ...(outcome as Record<string, unknown>),
      };
      delete mapped.rawPayload;
      expect(JSON.stringify(mapped)).not.toContain('102.71614508');
    });

    it('keeps their whole payload for replay', async () => {
      httpClient.postForOptionalData.mockResolvedValueOnce(
        theirPayload({ status: 1 }),
      );

      const outcome = await lookUp();

      expect(outcome).toHaveProperty('rawPayload', theirPayload({ status: 1 }));
    });

    it('reports their failure with the reason they gave', async () => {
      httpClient.postForOptionalData.mockResolvedValueOnce(
        theirPayload({ status: 2, fail_reason: 'Insufficient balance' }),
      );

      await expect(lookUp()).resolves.toMatchObject({
        state: 'FAILED',
        reason: 'Insufficient balance',
      });
    });

    it('omits the reason on a failure they gave none for', async () => {
      // Their empty fields arrive as `""` rather than as absent keys, and an
      // absent optional is how this port says "no reason" — under
      // `exactOptionalPropertyTypes` it cannot be set to undefined to say the
      // same thing.
      httpClient.postForOptionalData.mockResolvedValueOnce(
        theirPayload({ status: 2 }),
      );

      const outcome = await lookUp();

      expect(outcome).toMatchObject({ state: 'FAILED' });
      expect(outcome).not.toHaveProperty('reason');
    });

    it('does not read their fail reason on any other status', async () => {
      // Their page states the field carries a value only on their failure
      // status. A settled deposit carrying stale text would attach a failure
      // reason to money that arrived.
      httpClient.postForOptionalData.mockResolvedValueOnce(
        theirPayload({
          status: 1,
          fail_reason: 'left over from an earlier attempt',
        }),
      );

      const outcome = await lookUp();

      expect(outcome).not.toHaveProperty('reason');
    });

    it.each([
      [3, 'REFUND_PENDING'],
      [4, 'REFUNDED'],
    ])('maps their status %i to %s', async (status, state) => {
      httpClient.postForOptionalData.mockResolvedValueOnce(
        theirPayload({ status }),
      );

      await expect(lookUp()).resolves.toMatchObject({ state });
    });

    it('leaves a status they have not documented as no outcome yet', async () => {
      // Waiting is the only recoverable direction: a code guessed into a
      // terminal state stops the pass ever correcting itself.
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      httpClient.postForOptionalData.mockResolvedValueOnce(
        theirPayload({ status: 9 }),
      );

      await expect(lookUp()).resolves.toMatchObject({ state: 'PENDING' });
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('reads their status when it arrives as a string', async () => {
      // The live query returns it as a number; their sample quotes several of
      // its siblings. Neither column of their documentation is trustworthy on
      // its own.
      httpClient.postForOptionalData.mockResolvedValueOnce(
        theirPayload({ status: '1' }),
      );

      await expect(lookUp()).resolves.toMatchObject({ state: 'SETTLED' });
    });

    it('waits rather than settling when their credited amount is unreadable', async () => {
      // A success with no readable fiat figure is a payload we do not
      // understand, and both alternatives are worse: settling with no amount
      // records a credit of unknown size, and settling with the coin figure
      // records the funding account's cost as the cardholder's money.
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      httpClient.postForOptionalData.mockResolvedValueOnce(
        theirPayload({ status: 1, currency_amount: '' }),
      );

      await expect(lookUp()).resolves.toMatchObject({ state: 'PENDING' });
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('ignores an order number they send as a JSON number', async () => {
      // Their order numbers are twenty digits, past what a double holds
      // exactly, so one arriving unquoted was already rounded by the parser.
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      httpClient.postForOptionalData.mockResolvedValueOnce(
        theirPayload({ status: 1, order_no: Number('20250719104417971096') }),
      );

      const outcome = await lookUp();

      expect(outcome).toMatchObject({ state: 'SETTLED' });
      expect(outcome).not.toHaveProperty('providerDepositId');
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('refuses a payload describing a different card', async () => {
      // Their query echoes both halves of the key it was given.
      httpClient.postForOptionalData.mockResolvedValueOnce(
        theirPayload({ status: 1, card_id: '00003454323400000099999' }),
      );

      await expect(lookUp()).rejects.toBeInstanceOf(
        HyperCardResponseMismatchError,
      );
    });

    it('refuses a payload carrying a different reference', async () => {
      httpClient.postForOptionalData.mockResolvedValueOnce(
        theirPayload({
          status: 1,
          mc_trade_no: 'ffffffffffffffffffffffffffffffff',
        }),
      );

      await expect(lookUp()).rejects.toBeInstanceOf(
        HyperCardResponseMismatchError,
      );
    });

    it('accepts a payload that echoes neither identifier', async () => {
      // Absent is not disagreement. Their empty values arrive as `""`, and a
      // refusal on a field they simply did not send would fail every lookup.
      httpClient.postForOptionalData.mockResolvedValueOnce(
        theirPayload({ status: 1, card_id: '', mc_trade_no: '' }),
      );

      await expect(lookUp()).resolves.toMatchObject({ state: 'SETTLED' });
    });

    it('does not read a numeric echo as a disagreement', async () => {
      // A rounded value is unreadable, not evidence that they answered about
      // something else — refusing on it would fail a settlement over their
      // serialiser rather than over their records.
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      httpClient.postForOptionalData.mockResolvedValueOnce(
        theirPayload({ status: 1, card_id: Number('3454323400000028888') }),
      );

      await expect(lookUp()).resolves.toMatchObject({ state: 'SETTLED' });
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('omits the deposit id when they report none', async () => {
      httpClient.postForOptionalData.mockResolvedValueOnce(
        theirPayload({ status: 1, order_no: '' }),
      );

      const outcome = await lookUp();

      expect(outcome).toMatchObject({ state: 'SETTLED' });
      expect(outcome).not.toHaveProperty('providerDepositId');
    });

    it('reads a success carrying no payload as a reference they do not hold', async () => {
      httpClient.postForOptionalData.mockResolvedValueOnce(null);

      await expect(lookUp()).resolves.toEqual({ state: 'UNKNOWN_REFERENCE' });
    });

    it('does not translate their parameter error into a missing deposit', async () => {
      // Measured against their sandbox, not assumed.
      httpClient.postForOptionalData.mockRejectedValueOnce(
        new HyperCardApiError(
          200,
          'A0003',
          'HyperCard card recharge query failed (HTTP 200, code=A0003): Parameter error',
        ),
      );

      await expect(lookUp()).rejects.toMatchObject({ code: 'A0003' });
    });

    it('refuses a reference that is not a canonical UUID', async () => {
      await expect(
        adapter.getCardDepositResult(PROVIDER_CARD_ID, 'not-a-uuid'),
      ).rejects.toBeInstanceOf(HyperCardTradeNumberError);
      expect(httpClient.postForOptionalData).not.toHaveBeenCalled();
    });
  });

  describe('getCardBalance', () => {
    const PROVIDER_CARD_ID = '30806984524000022826';

    /** Their "Balance Inquiry" page's own example payload, verbatim. */
    const theirPayload = (overrides: Record<string, unknown> = {}) => ({
      available_balance: '100.00',
      card_currency: 'usd',
      card_number: '111111******0628',
      card_type: 'N/A',
      current_balance: '1000.00',
      ...overrides,
    });

    it('asks their balance inquiry by the card id, as a string', async () => {
      httpClient.post.mockResolvedValueOnce(theirPayload());

      await adapter.getCardBalance(PROVIDER_CARD_ID);

      // A string because their parameter table says so. Their example sends it
      // unquoted, and their twenty-digit ids do not survive a double — so the
      // example is the wrong half of their documentation.
      expect(httpClient.post).toHaveBeenCalledWith(
        'card balance inquiry',
        '/openapi/card/balance',
        { card_id: PROVIDER_CARD_ID },
      );
    });

    it('maps their payload onto the port', async () => {
      httpClient.post.mockResolvedValueOnce(theirPayload());

      const balance = await adapter.getCardBalance(PROVIDER_CARD_ID);

      expect(balance).toMatchObject({
        available: '100.00',
        ledger: '1000.00',
        // Lowercase on the wire, upper case in this schema.
        currencyCode: 'USD',
      });
    });

    it('reports the amounts in the currency’s own units, unconverted', async () => {
      // The reading these columns now carry, asserted at the boundary that
      // would have had to convert. Their appendix lists seven currencies whose
      // minor-unit exponent is not two, so no constant conversion exists.
      httpClient.post.mockResolvedValueOnce(
        theirPayload({ available_balance: '10.00', current_balance: '10.00' }),
      );

      const balance = await adapter.getCardBalance(PROVIDER_CARD_ID);

      expect(balance.available).toBe('10.00');
      expect(balance.ledger).toBe('10.00');
    });

    it('observes at the time of the call, since their payload carries none', async () => {
      const before = Date.now();
      httpClient.post.mockResolvedValueOnce(theirPayload());

      const balance = await adapter.getCardBalance(PROVIDER_CARD_ID);

      const observed = Date.parse(balance.observedAt);
      expect(observed).toBeGreaterThanOrEqual(before);
      expect(observed).toBeLessThanOrEqual(Date.now());
    });

    it('never answers null, unlike an issuer with a pre-balance state', async () => {
      // Their documentation has no state in which a card exists and has no
      // balance; a card they do not hold is a refusal instead — see the case
      // below. So the reconcile pass's null branch is unreachable through this
      // adapter, and nothing here should grow a defensive one.
      httpClient.post.mockResolvedValueOnce(theirPayload());

      await expect(
        adapter.getCardBalance(PROVIDER_CARD_ID),
      ).resolves.not.toBeNull();
    });

    it('lets their "card no existed" refusal through', async () => {
      // Their code for a card they do not hold. Not in the conflict set — it is
      // a not-found rather than a state problem — so it stays a plain
      // HyperCardApiError carrying a real `code`, and the pass's per-row
      // isolation turns it into a warning with the row left alone.
      httpClient.post.mockRejectedValueOnce(
        new HyperCardApiError(200, 'A0004', 'Card no existed'),
      );

      await expect(
        adapter.getCardBalance(PROVIDER_CARD_ID),
      ).rejects.toMatchObject({ code: 'A0004' });
    });

    it('refuses a payload it cannot read rather than reporting an empty balance', async () => {
      httpClient.post.mockResolvedValueOnce(
        theirPayload({ available_balance: '' }),
      );

      await expect(
        adapter.getCardBalance(PROVIDER_CARD_ID),
      ).rejects.toBeInstanceOf(HyperCardCardBalanceError);
    });

    it('does not report their masked number back', async () => {
      // The card row's masked number comes from the lookup that opened the
      // card. A balance read is not the place to rewrite it, and their sandbox
      // answers at least one endpoint with one canned card for every id.
      httpClient.post.mockResolvedValueOnce(theirPayload());

      const balance = await adapter.getCardBalance(PROVIDER_CARD_ID);

      expect(JSON.stringify(balance)).not.toContain('111111******0628');
    });
  });

  describe('getMerchantBalance', () => {
    /** Their "Merchant Balance" page's own example row, verbatim. */
    const theirRows = [
      { amount: '100.00', coin: 'usdt', total_amount: '100.888888' },
    ];

    it('asks their merchant balance endpoint with no coin filter', async () => {
      httpClient.postForOptionalData.mockResolvedValueOnce(theirRows);

      await adapter.getMerchantBalance();

      expect(httpClient.postForOptionalData).toHaveBeenCalledWith(
        'merchant balance inquiry',
        '/openapi/card/merchant/balance',
        {},
      );
    });

    it('maps their rows onto the port', async () => {
      httpClient.postForOptionalData.mockResolvedValueOnce(theirRows);

      const float = await adapter.getMerchantBalance();

      expect(float.entries).toEqual([
        { currencyCode: 'USDT', available: '100.00', ledger: '100.888888' },
      ]);
    });

    it('reads an absent payload as an empty float, not a failure', async () => {
      httpClient.postForOptionalData.mockResolvedValueOnce(null);

      await expect(adapter.getMerchantBalance()).resolves.toMatchObject({
        entries: [],
      });
    });

    it('refuses a payload that is not a list rather than reporting nothing held', async () => {
      httpClient.postForOptionalData.mockResolvedValueOnce({});

      await expect(adapter.getMerchantBalance()).rejects.toBeInstanceOf(
        HyperCardMerchantBalanceError,
      );
    });

    it('observes at the time of the call, since their payload carries none', async () => {
      const before = Date.now();
      httpClient.postForOptionalData.mockResolvedValueOnce(theirRows);

      const float = await adapter.getMerchantBalance();

      const observed = Date.parse(float.observedAt);
      expect(observed).toBeGreaterThanOrEqual(before);
      expect(observed).toBeLessThanOrEqual(Date.now());
    });

    it('refuses a row it cannot read rather than understating the float', async () => {
      httpClient.postForOptionalData.mockResolvedValueOnce([
        ...theirRows,
        { amount: '', coin: 'usdc', total_amount: '' },
      ]);

      await expect(adapter.getMerchantBalance()).rejects.toBeInstanceOf(
        HyperCardMerchantBalanceError,
      );
    });
  });

  describe('structurally unsupported port methods', () => {
    // Driven off the list rather than off `submitKyc` by name, so a second
    // method moved into it inherits all three invariants instead of arriving
    // with none. Same shape as the unimplemented block below — that block and
    // this one differ only in which error type they expect.
    const methods = structurallyUnsupportedMethods;

    const invoke = (method: (typeof methods)[number]): Promise<unknown> =>
      (adapter[method] as () => Promise<unknown>)();

    it.each(methods)(
      "%s refuses with the domain error, not this folder's own",
      async (method) => {
        // The type is the whole point: a use-case has to tell "this issuer has
        // no such step" apart from "we have not built it yet", and it cannot
        // import this folder's error to do it.
        await expect(invoke(method)).rejects.toBeInstanceOf(
          CardProviderUnsupportedOperationError,
        );
      },
    );

    it.each(methods)(
      '%s names the provider and the operation',
      async (method) => {
        await expect(invoke(method)).rejects.toMatchObject({
          providerKey: CardProviderKey.HYPERCARD,
          operation: method,
        });
      },
    );

    it.each(methods)(
      '%s returns a promise rather than throwing synchronously',
      (method) => {
        const returned = invoke(method);

        expect(returned).toBeInstanceOf(Promise);
        returned.catch(() => undefined);
      },
    );

    it.each(methods)('%s does not reach the transport', async (method) => {
      await expect(invoke(method)).rejects.toThrow();

      expect(httpClient.post).not.toHaveBeenCalled();
      expect(httpClient.postForAck).not.toHaveBeenCalled();
      expect(httpClient.postForOptionalData).not.toHaveBeenCalled();
    });

    it('tells a partner what to do instead of only why', async () => {
      // `reason`, not `message`: this is the half the caller puts in the 409
      // body, so it has to end in the partner's next call rather than in the
      // diagnosis.
      await expect(adapter.submitKyc()).rejects.toMatchObject({
        reason: expect.stringContaining('Issue the card') as unknown as string,
      });
    });
  });

  describe('getCardTransactions', () => {
    const PROVIDER_CARD_ID = '30806984524000022826';

    /**
     * A live statement from their sandbox, read through this endpoint rather
     * than copied from their page — which their own example contradicts: it
     * publishes the four amount fields as JSON numbers and omits the status
     * its parameter table declares, where the live endpoint sends strings and
     * a numeric status.
     */
    const theirRow = (overrides: Record<string, unknown> = {}) => ({
      tx_id: '202608182138436344937976',
      description: '',
      debit: '0.00000000',
      credit: '11.00000000',
      fee: '0.00000000',
      type: 2,
      tx_currency: 'usd',
      tx_amount: '11.00000000',
      status: 1,
      transaction_date: '1787060323',
      posting_date: '1787060323',
      mc_trade_no: 'aa7dafbbb38342cbb5af121bfaa65f4f',
      ...overrides,
    });

    const theirStatement = (rows: Record<string, unknown>[]) => [
      {
        month_year: '082026',
        statement_cycle_date: '1787060323',
        bank_tx_list: rows,
      },
    ];

    it('asks their card statement for a month range, not a timestamp range', async () => {
      httpClient.postForOptionalData.mockResolvedValueOnce(
        theirStatement([theirRow()]),
      );

      await adapter.getCardTransactions(PROVIDER_CARD_ID, {
        after: Math.floor(Date.parse('2026-06-01T00:00:00Z') / 1000),
        before: Math.floor(Date.parse('2026-07-15T00:00:00Z') / 1000),
      });

      expect(httpClient.postForOptionalData).toHaveBeenCalledWith(
        'card statement inquiry',
        '/v2/openapi/card/transaction/record',
        {
          card_id: PROVIDER_CARD_ID,
          start_time: '062026',
          end_time: '072026',
        },
      );
    });

    it('flattens every month of their answer into one list', async () => {
      httpClient.postForOptionalData.mockResolvedValueOnce([
        {
          month_year: '072026',
          bank_tx_list: [
            theirRow({ tx_id: 'older', transaction_date: '1782000000' }),
          ],
        },
        {
          month_year: '082026',
          bank_tx_list: [theirRow({ tx_id: 'newer' })],
        },
      ]);

      const result = await adapter.getCardTransactions(PROVIDER_CARD_ID, {});

      // Newest first, which is the direction `before` and a cursor read in.
      expect(result.items.map((item) => item.id)).toEqual(['newer', 'older']);
    });

    it('publishes the deposit a partner made, which is why this endpoint and not their merchant-wide one', async () => {
      // Their merchant-wide query makes a business type required, so a call
      // filtered to consumption returns a card history with every recharge
      // missing and looks healthy doing it. Their recharge type is 2.
      httpClient.postForOptionalData.mockResolvedValueOnce(
        theirStatement([theirRow()]),
      );

      const result = await adapter.getCardTransactions(PROVIDER_CARD_ID, {});

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        category: 'recharge',
        amount: '11.00000000',
        currencyCode: 'USD',
        status: 'settled',
      });
    });

    it('trims an answer that reaches past the range asked for', async () => {
      // Their statements are whole months, so a range starting mid-month comes
      // back carrying the days before it.
      const inside = Math.floor(Date.parse('2026-08-18T13:38:43Z') / 1000);
      const before = Math.floor(Date.parse('2026-08-01T00:00:00Z') / 1000);

      httpClient.postForOptionalData.mockResolvedValueOnce(
        theirStatement([
          theirRow({ tx_id: 'inside', transaction_date: String(inside) }),
          theirRow({ tx_id: 'outside', transaction_date: String(before) }),
        ]),
      );

      const result = await adapter.getCardTransactions(PROVIDER_CARD_ID, {
        after: inside - 60,
        before: inside + 60,
      });

      expect(result.items.map((item) => item.id)).toEqual(['inside']);
    });

    it('returns an empty list and no cursor for a card with no activity', async () => {
      // Their live answer omits a month with no rows entirely rather than
      // returning an empty statement for it, so both shapes reach here.
      httpClient.postForOptionalData.mockResolvedValueOnce([]);

      await expect(
        adapter.getCardTransactions(PROVIDER_CARD_ID, {}),
      ).resolves.toEqual({ items: [], nextCursor: null });
    });

    describe('paging, which is entirely this adapter’s', () => {
      const manyRows = (count: number) =>
        Array.from({ length: count }, (_unused, index) =>
          theirRow({
            tx_id: `tx-${String(index).padStart(2, '0')}`,
            transaction_date: String(1787060323 - index * 60),
          }),
        );

      it('windows to the limit and hands back a cursor', async () => {
        httpClient.postForOptionalData.mockResolvedValueOnce(
          theirStatement(manyRows(5)),
        );

        const result = await adapter.getCardTransactions(PROVIDER_CARD_ID, {
          limit: 2,
        });

        expect(result.items.map((item) => item.id)).toEqual(['tx-00', 'tx-01']);
        expect(result.nextCursor).toEqual(expect.any(String));
      });

      it('continues where the last page stopped, without repeating or skipping', async () => {
        httpClient.postForOptionalData.mockResolvedValueOnce(
          theirStatement(manyRows(5)),
        );
        const first = await adapter.getCardTransactions(PROVIDER_CARD_ID, {
          limit: 2,
        });

        httpClient.postForOptionalData.mockResolvedValueOnce(
          theirStatement(manyRows(5)),
        );
        const second = await adapter.getCardTransactions(PROVIDER_CARD_ID, {
          limit: 2,
          cursor: first.nextCursor!,
        });

        expect(second.items.map((item) => item.id)).toEqual(['tx-02', 'tx-03']);
      });

      it('has no cursor on the last page', async () => {
        httpClient.postForOptionalData.mockResolvedValueOnce(
          theirStatement(manyRows(2)),
        );

        const result = await adapter.getCardTransactions(PROVIDER_CARD_ID, {
          limit: 2,
        });

        expect(result.items).toHaveLength(2);
        expect(result.nextCursor).toBeNull();
      });

      it('separates two rows sharing a second by their identifier', async () => {
        // Their timestamps are whole seconds, so without the tie-break these
        // two could swap between calls — dropping one page's row and repeating
        // it on the next, with nothing reporting either.
        httpClient.postForOptionalData.mockResolvedValueOnce(
          theirStatement([
            theirRow({ tx_id: 'aaa' }),
            theirRow({ tx_id: 'bbb' }),
          ]),
        );
        const first = await adapter.getCardTransactions(PROVIDER_CARD_ID, {
          limit: 1,
        });

        httpClient.postForOptionalData.mockResolvedValueOnce(
          theirStatement([
            theirRow({ tx_id: 'aaa' }),
            theirRow({ tx_id: 'bbb' }),
          ]),
        );
        const second = await adapter.getCardTransactions(PROVIDER_CARD_ID, {
          limit: 1,
          cursor: first.nextCursor!,
        });

        expect(first.items[0]!.id).toBe('bbb');
        expect(second.items[0]!.id).toBe('aaa');
      });
    });

    it('reads their empty answer as an empty statement, not as a failure', async () => {
      // Their endpoints answer a legitimate "nothing here" with no payload at
      // all — the card catalogue does it for a merchant with no products — and
      // a card that has never transacted is exactly that case. Routing this
      // through the data-bearing call would answer it with a server fault.
      httpClient.postForOptionalData.mockResolvedValueOnce(null);

      await expect(
        adapter.getCardTransactions(PROVIDER_CARD_ID, {}),
      ).resolves.toEqual({ items: [], nextCursor: null });
    });

    it('refuses a payload that is not a list of statements', async () => {
      // Nothing validates a response body against the type the transport was
      // asked for, and they have already contradicted their own documentation
      // on five fields of this endpoint.
      httpClient.postForOptionalData.mockResolvedValueOnce({ records: [] });

      await expect(
        adapter.getCardTransactions(PROVIDER_CARD_ID, {}),
      ).rejects.toBeInstanceOf(HyperCardTransactionError);
    });

    it('is not failed by an unreadable row outside the range asked for', async () => {
      // Their statements are whole months, so a two-day range still arrives
      // carrying the rest of the month. A malformed row the caller never asked
      // about must not take their listing down with it.
      const inside = Math.floor(Date.parse('2026-08-18T13:38:43Z') / 1000);
      const outside = Math.floor(Date.parse('2026-08-02T00:00:00Z') / 1000);

      httpClient.postForOptionalData.mockResolvedValueOnce(
        theirStatement([
          theirRow({ tx_id: 'inside', transaction_date: String(inside) }),
          theirRow({
            tx_id: 'outside',
            transaction_date: String(outside),
            tx_amount: 'not an amount',
          }),
        ]),
      );

      const result = await adapter.getCardTransactions(PROVIDER_CARD_ID, {
        after: inside - 60,
        before: inside + 60,
      });

      expect(result.items.map((item) => item.id)).toEqual(['inside']);
    });

    it('still fails loudly for an unreadable row it cannot place in the range', async () => {
      // A row whose date cannot be read cannot be shown to be outside the range
      // either, so it is kept and fails in the mapper rather than being dropped
      // from a statement that would then be silently short.
      httpClient.postForOptionalData.mockResolvedValueOnce(
        theirStatement([theirRow({ transaction_date: 'yesterday' })]),
      );

      await expect(
        adapter.getCardTransactions(PROVIDER_CARD_ID, {
          after: 1787060000,
          before: 1787060999,
        }),
      ).rejects.toBeInstanceOf(HyperCardTransactionError);
    });

    it('keeps a row the issuer timestamped ahead of our own clock', async () => {
      // The unbounded window asks for the whole current month, so bounding the
      // answer at our clock would fetch the newest row and then discard it —
      // and the newest row is what a caller polling after a deposit is waiting
      // for. A few seconds of skew is enough.
      const ahead = Math.floor(Date.now() / 1000) + 120;
      httpClient.postForOptionalData.mockResolvedValueOnce(
        theirStatement([
          theirRow({ tx_id: 'ahead', transaction_date: String(ahead) }),
        ]),
      );

      const result = await adapter.getCardTransactions(PROVIDER_CARD_ID, {});

      expect(result.items.map((item) => item.id)).toEqual(['ahead']);
    });

    it('refuses a range wider than their statement serves, before calling them', async () => {
      await expect(
        adapter.getCardTransactions(PROVIDER_CARD_ID, {
          after: Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000),
          before: Math.floor(Date.parse('2026-08-01T00:00:00Z') / 1000),
        }),
      ).rejects.toBeInstanceOf(CardProviderIntentRejectedError);

      expect(httpClient.postForOptionalData).not.toHaveBeenCalled();
    });

    it('refuses a cursor it did not issue, before calling them', async () => {
      await expect(
        adapter.getCardTransactions(PROVIDER_CARD_ID, {
          cursor: 'not-a-cursor-this-issued',
        }),
      ).rejects.toBeInstanceOf(CardProviderIntentRejectedError);

      expect(httpClient.postForOptionalData).not.toHaveBeenCalled();
    });
  });

  describe('updateCardStatus', () => {
    const PROVIDER_CARD_ID = '30806984524000022826';
    const REFERENCE = '48d27417-47a4-49b2-968a-91e2523feb22';

    /** Their "Card operation request" page answers with an ack and no data. */
    const theirAcknowledgement = () => undefined;

    const block = (): Promise<CardLifecycleOperationResult> =>
      adapter.updateCardStatus(PROVIDER_CARD_ID, {
        reference: REFERENCE,
        status: 'on_hold',
        reason: 'fraud_review',
      });

    const unblock = (): Promise<CardLifecycleOperationResult> =>
      adapter.updateCardStatus(PROVIDER_CARD_ID, {
        reference: REFERENCE,
        status: 'active',
      });

    it('freezes with their type 1, the card id and the derived reference', async () => {
      httpClient.postForAck.mockResolvedValueOnce(theirAcknowledgement());

      await block();

      expect(httpClient.postForAck).toHaveBeenCalledWith(
        'card block',
        '/openapi/card/operation',
        {
          card_id: PROVIDER_CARD_ID,
          request_number: '48d2741747a449b2968a91e2523feb22',
          type: 1,
        },
      );
    });

    it('unfreezes with their type 2', async () => {
      httpClient.postForAck.mockResolvedValueOnce(theirAcknowledgement());

      await unblock();

      expect(httpClient.postForAck).toHaveBeenCalledWith(
        'card unblock',
        '/openapi/card/operation',
        expect.objectContaining({ type: 2 }),
      );
    });

    it('sends nothing their other operation types need', async () => {
      httpClient.postForAck.mockResolvedValueOnce(theirAcknowledgement());

      await block();

      const [, , body] = httpClient.postForAck.mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
      ];
      expect(Object.keys(body).sort()).toEqual([
        'card_id',
        'request_number',
        'type',
      ]);
    });

    it('uses postForAck, so a missing payload is neither an error nor an outcome', async () => {
      httpClient.postForAck.mockResolvedValueOnce(theirAcknowledgement());

      await block();

      expect(httpClient.post).not.toHaveBeenCalled();
      expect(httpClient.postForOptionalData).not.toHaveBeenCalled();
    });

    it('returns the submitted arm, which carries no card status', async () => {
      httpClient.postForAck.mockResolvedValueOnce(theirAcknowledgement());

      const result = await block();

      // The bank works the request by hand afterwards, so there is no status
      // to report and the type must not offer one to report it in.
      expect(result).toEqual({
        state: 'SUBMITTED',
        operation: 'block',
        reference: REFERENCE,
      });
      expect(result).not.toHaveProperty('status');
    });

    it('never returns the applied arm, whatever they answer', async () => {
      httpClient.postForAck.mockResolvedValueOnce(theirAcknowledgement());

      const result = await block();

      expect(result.state).not.toBe('APPLIED');
    });

    it('refuses a reference that is not a canonical UUID', async () => {
      // The derivation is injective only for one, and a wrong reference loses
      // the operation rather than just the request.
      await expect(
        adapter.updateCardStatus(PROVIDER_CARD_ID, {
          reference: 'not-a-uuid',
          status: 'on_hold',
        }),
      ).rejects.toBeInstanceOf(HyperCardTradeNumberError);

      expect(httpClient.postForAck).not.toHaveBeenCalled();
    });

    it('propagates a failure code that is not a state refusal as a HyperCardApiError', async () => {
      // Asserted on a non-conflict code deliberately: a conflict one is
      // translated to CardProviderConflictError, which carries `providerCode`
      // and no `code` — so this expectation would pass against it vacuously.
      httpClient.postForAck.mockRejectedValueOnce(
        new HyperCardApiError(200, 'A0003', 'Parameter error'),
      );

      await expect(block()).rejects.toMatchObject({ code: 'A0003' });
    });

    it('surfaces an undocumented refusal code unchanged rather than guessing at it', async () => {
      // Only their generic client error is translated, and only here.
      httpClient.postForAck.mockRejectedValueOnce(
        new HyperCardApiError(200, 'A9999', 'An operation is in progress'),
      );

      await expect(block()).rejects.toMatchObject({
        code: 'A9999',
        name: 'HyperCardApiError',
      });
    });

    describe('their generic client error, which they discriminate only in prose', () => {
      /** Their own wording, from a freeze refused on this endpoint. */
      const ALLOWANCE_SPENT =
        'HyperCard card block failed (HTTP 200, code=A0000): Client error:You have already submitted an Freeze application. Applications can only be submitted once within 24 hours.';

      it('reads their allowance wording as a refusal only waiting clears', async () => {
        httpClient.postForAck.mockRejectedValue(
          new HyperCardApiError(200, 'A0000', ALLOWANCE_SPENT),
        );

        await expect(block()).rejects.toBeInstanceOf(
          CardProviderThrottledError,
        );
        await expect(block()).rejects.toMatchObject({ providerCode: 'A0000' });
      });

      it('reads any other wording as a state refusal', async () => {
        // The safe direction if they reword.
        httpClient.postForAck.mockRejectedValue(
          new HyperCardApiError(
            200,
            'A0000',
            'HyperCard card block failed (HTTP 200, code=A0000): Client error:The current card status does not allow this operation',
          ),
        );

        await expect(block()).rejects.toBeInstanceOf(CardProviderConflictError);
        await expect(block()).rejects.not.toBeInstanceOf(
          CardProviderThrottledError,
        );
      });

      it('translates it on this endpoint only, never through the shared code set', () => {
        // Elsewhere that code also means a reference they do not hold.
        expect(
          assertHyperCardSuccess.bind(null, 'anything', 200, {
            code: 'A0000',
            msg: 'Client error:something else entirely',
          }),
        ).toThrow(HyperCardApiError);
      });
    });

    it('lets a state refusal through as the provider-neutral conflict error', async () => {
      httpClient.postForAck.mockRejectedValueOnce(
        new CardProviderConflictError(
          CardProviderKey.HYPERCARD,
          'A0005',
          'HyperCard card block failed (HTTP 200, code=A0005): Duplicated request',
        ),
      );

      await expect(block()).rejects.toBeInstanceOf(CardProviderConflictError);
    });
  });

  describe('getCardOperationResult', () => {
    const PROVIDER_CARD_ID = '30806984524000022826';
    const REFERENCE = '48d27417-47a4-49b2-968a-91e2523feb22';
    const TRADE_NUMBER = '48d2741747a449b2968a91e2523feb22';

    /**
     * Their "Card Operation result" payload for a freeze: both express fields
     * present and empty, though their page says those are a replacement's.
     */
    const theirResult = (overrides: Record<string, unknown> = {}) => ({
      card_id: PROVIDER_CARD_ID,
      request_number: TRADE_NUMBER,
      operate_status: 1,
      express_company: '',
      express_no: '',
      ...overrides,
    });

    const lookUp = (
      operation: CardLifecycleOperation = CardLifecycleOperation.BLOCK,
    ): Promise<CardOperationOutcome> =>
      adapter.getCardOperationResult(PROVIDER_CARD_ID, REFERENCE, operation);

    it('asks their result endpoint with the card, the derived reference and their type', async () => {
      httpClient.post.mockResolvedValueOnce(theirResult());

      await lookUp();

      expect(httpClient.post).toHaveBeenCalledWith(
        'card operation result',
        '/v2/openapi/card/operation/result',
        {
          card_id: PROVIDER_CARD_ID,
          request_number: TRADE_NUMBER,
          type: 1,
        },
      );
    });

    it('sends their type 2 for an unblock', async () => {
      httpClient.post.mockResolvedValueOnce(theirResult());

      await lookUp(CardLifecycleOperation.UNBLOCK);

      expect(httpClient.post).toHaveBeenCalledWith(
        'card operation result',
        '/v2/openapi/card/operation/result',
        expect.objectContaining({ type: 2 }),
      );
    });

    it('uses post, because a missing payload is not an outcome here', async () => {
      // Unlike their recharge query, where an empty success means they hold
      // nothing: here an unknown reference is an error code instead.
      httpClient.post.mockResolvedValueOnce(theirResult());

      await lookUp();

      expect(httpClient.postForOptionalData).not.toHaveBeenCalled();
      expect(httpClient.postForAck).not.toHaveBeenCalled();
    });

    it.each([
      [1, 'APPLIED'],
      ['1', 'APPLIED'],
      [0, 'PENDING'],
      [99, 'PENDING'],
      [98, 'PENDING'],
      ['99', 'PENDING'],
    ])('reads their status %s as %s', async (operateStatus, state) => {
      httpClient.post.mockResolvedValueOnce(
        theirResult({ operate_status: operateStatus }),
      );

      await expect(lookUp()).resolves.toMatchObject({ state });
    });

    it('reads their failure as failed, carrying no reason of theirs', async () => {
      httpClient.post.mockResolvedValueOnce(theirResult({ operate_status: 2 }));

      const outcome = await lookUp();

      // No reason field on this endpoint at all, unlike their recharge query.
      expect(outcome).toEqual({
        state: 'FAILED',
        rawPayload: theirResult({ operate_status: 2 }),
      });
    });

    it('keeps an unreadable status pending rather than guessing at it', async () => {
      httpClient.post.mockResolvedValueOnce(theirResult({ operate_status: 7 }));

      await expect(lookUp()).resolves.toMatchObject({ state: 'PENDING' });
    });

    it('reads their generic client error as no outcome yet, never as not held', async () => {
      // Their answer for a reference never sent: a generic code with the
      // detail in free text only. It also covers a malformed request and a
      // wrong card, so reading it as "no such operation" would let one bad
      // lookup retire a real one for ever.
      httpClient.post.mockRejectedValueOnce(
        new HyperCardApiError(
          200,
          'A0000',
          `Client error:${TRADE_NUMBER} does not exist`,
        ),
      );

      const outcome = await lookUp();

      expect(outcome).toEqual({ state: 'PENDING' });
      expect(outcome.state).not.toBe('UNKNOWN_REFERENCE');
    });

    it('propagates any other failure code', async () => {
      httpClient.post.mockRejectedValueOnce(
        new HyperCardApiError(200, 'A0004', 'Card no existed'),
      );

      await expect(lookUp()).rejects.toMatchObject({ code: 'A0004' });
    });

    it('refuses a payload describing another card', async () => {
      httpClient.post.mockResolvedValueOnce(
        theirResult({ card_id: '30830869524000023908' }),
      );

      await expect(lookUp()).rejects.toBeInstanceOf(
        HyperCardResponseMismatchError,
      );
    });

    it('refuses a payload carrying another reference', async () => {
      httpClient.post.mockResolvedValueOnce(
        theirResult({ request_number: 'ffffffffffffffffffffffffffffffff' }),
      );

      await expect(lookUp()).rejects.toBeInstanceOf(
        HyperCardResponseMismatchError,
      );
    });

    it('accepts a payload that echoes neither identifier', async () => {
      // Their empty value is `""` rather than an absent key, so a blank echo
      // must not read as a mismatch.
      httpClient.post.mockResolvedValueOnce(
        theirResult({ card_id: '', request_number: '' }),
      );

      await expect(lookUp()).resolves.toMatchObject({ state: 'APPLIED' });
    });

    it('refuses an operation it does not carry out', async () => {
      await expect(
        lookUp(CardLifecycleOperation.CANCEL),
      ).rejects.toBeInstanceOf(CardProviderUnsupportedOperationError);

      expect(httpClient.post).not.toHaveBeenCalled();
    });

    it('refuses a reference that is not a canonical UUID', async () => {
      await expect(
        adapter.getCardOperationResult(
          PROVIDER_CARD_ID,
          'not-a-uuid',
          CardLifecycleOperation.BLOCK,
        ),
      ).rejects.toBeInstanceOf(HyperCardTradeNumberError);

      expect(httpClient.post).not.toHaveBeenCalled();
    });
  });

  describe('unimplemented port methods', () => {
    // The scaffold's contract for a method not built yet is that it exists and
    // refuses with a typed error — never a bare Error, and never a silent no-op
    // returning a fabricated result a use-case would then persist.
    const methods = unimplementedMethods;

    const invoke = (method: (typeof methods)[number]): Promise<unknown> =>
      (adapter[method] as () => Promise<unknown>)();

    it.each(methods)(
      '%s rejects with HyperCardNotImplementedError',
      async (method) => {
        // `rejects`, not `toThrow`: a port method declared Promise<T> must
        // return a rejected promise rather than throw synchronously, or a
        // caller using .catch() or Promise.allSettled() never sees it.
        await expect(invoke(method)).rejects.toBeInstanceOf(
          HyperCardNotImplementedError,
        );
        await expect(invoke(method)).rejects.toThrow(method);
      },
    );

    it.each(methods)(
      '%s returns a promise rather than throwing synchronously',
      (method) => {
        // Guards the above: if the method threw synchronously, calling it
        // outside a try/catch would blow up here instead of yielding a promise.
        const returned = invoke(method);

        expect(returned).toBeInstanceOf(Promise);
        returned.catch(() => undefined);
      },
    );

    it.each(methods)('%s does not reach the transport', async (method) => {
      await expect(invoke(method)).rejects.toThrow();

      expect(httpClient.post).not.toHaveBeenCalled();
      expect(httpClient.postForAck).not.toHaveBeenCalled();
      expect(httpClient.postForOptionalData).not.toHaveBeenCalled();
    });
  });

  describe('readCallback and callbackAck', () => {
    /**
     * Their own five signed headers, the set an outbound request carries.
     * Their documentation names none for a callback, so this is the same
     * inference `pickSignedHeaders` makes.
     */
    const signedHeaders = {
      timestamp: '1747984101',
      nonce: 'a1b2c3d4e5',
      'api-key': 'merchant-key',
      version: '1.0',
      lang: 'en',
    };

    /** Signs a body the way their platform is assumed to. */
    const sign = (body: Record<string, unknown>): string =>
      createSign('RSA-SHA256')
        .update(buildHyperCardCanonicalString(signedHeaders, body))
        .sign(platformPrivateKeyPem, 'base64');

    const deliver = (
      body: Record<string, unknown>,
      overrides: Record<string, string> = {},
    ): Promise<CardCallbackReading> =>
      adapter.readCallback({
        payload: body,
        headers: { ...signedHeaders, signature: sign(body), ...overrides },
      });

    /** The reference form their callbacks echo: a public id without its dashes. */
    const publicId = '48d27417-47a4-4936-9361-739208a1b2c3';
    const tradeNumber = publicId.replace(/-/g, '');

    // Their own examples from the common callback page, one per event type
    // they publish, trimmed only where a value has to be one of ours.
    const theirPayloads: Record<string, Record<string, unknown>> = {
      OPEN_CARD: {
        notify_type: 'OPEN_CARD',
        card_type_id: '40000002',
        email: 'example@gmail.com',
        mobile: '18301523750',
        mobile_code: '86',
        result: '1',
        remark: 'Remark',
        mc_trade_no: tradeNumber,
      },
      RECHARGE: {
        notify_type: 'RECHARGE',
        card_id: '00003454323400000028888',
        mc_trade_no: tradeNumber,
        result: '1',
      },
      OPERATION: {
        notify_type: 'OPERATION',
        request_number: tradeNumber,
        operate_status: '1',
        card_id: '00003454323400000028888',
      },
      CONSUME: {
        notify_type: 'CONSUME',
        card_id: '6654358889900018888',
        tx_id: '20230413145817505390',
      },
      BUY_COIN: {
        notify_type: 'BUY_COIN',
        reason: 'insufficient balance',
        mc_trade_no: tradeNumber,
        tx_id: '20230413145817505390',
        card_id: '6283244889900010107',
        status: '2',
      },
      CANCEL_CARD: {
        notify_type: 'CANCEL_CARD',
        card_id: '20230413145817505390',
        refund_amount: '100.00',
      },
      AUTH_3DS: {
        notify_type: 'AUTH_3DS',
        auth_id: 283,
        card_id: '15723682800000053333',
        card_no: '103411******3333',
        txn_currency: 'EUR',
        txn_amount: '1.00',
        auth_result: 2,
        auth_method: 1,
      },
      OPT_CODE: {
        notify_type: 'OPT_CODE',
        card_id: '1085185460000094505',
        code: '888666',
        create_time: 1710412477,
      },
      CARD_CONFIG_CHANGE: {
        notify_type: 'CARD_CONFIG_CHANGE',
        card_type_id: '40000002',
        modify_time: 1710412477,
      },
      CARD_STATUS_CHANGE: {
        notify_type: 'CARD_STATUS_CHANGE',
        card_id: '6232931889900031321',
        old_status: 9,
        new_status: 10,
        timestamp: 1747984101,
      },
      TRANSACTION_CHANGE: {
        notify_type: 'TRANSACTION_CHANGE',
        card_id: '2053333960000094692',
        tx_id: '202402040707554807197966',
        business_type: 1,
        timestamp: 1747984101,
      },
      CARD_CORRECTION_CHARGE: {
        notify_type: 'CARD_CORRECTION_CHARGE',
        type: 4,
        coin: 'usdt',
        tx_id: '202311221518043186056108809201',
        occurred_at: 1755243658,
        status: 1,
      },
    };

    const expectedArms: Record<string, CardCallbackEvent> = {
      OPEN_CARD: { kind: 'APPLICATION', reference: publicId },
      RECHARGE: { kind: 'DEPOSIT', reference: publicId },
      OPERATION: { kind: 'OPERATION', reference: publicId },
      CARD_CONFIG_CHANGE: { kind: 'PRODUCT_CATALOGUE' },
      CARD_STATUS_CHANGE: {
        kind: 'CARD_STATUS',
        providerCardId: '6232931889900031321',
        // Their code 10 is the freeze the API can lift.
        status: CardStatus.ON_HOLD,
      },
      CONSUME: { kind: 'UNHANDLED', label: 'CONSUME' },
      BUY_COIN: { kind: 'UNHANDLED', label: 'BUY_COIN' },
      CANCEL_CARD: { kind: 'UNHANDLED', label: 'CANCEL_CARD' },
      AUTH_3DS: { kind: 'UNHANDLED', label: 'AUTH_3DS' },
      OPT_CODE: { kind: 'UNHANDLED', label: 'OPT_CODE' },
      TRANSACTION_CHANGE: { kind: 'UNHANDLED', label: 'TRANSACTION_CHANGE' },
      CARD_CORRECTION_CHARGE: {
        kind: 'UNHANDLED',
        label: 'CARD_CORRECTION_CHARGE',
      },
    };

    it.each(Object.keys(theirPayloads))(
      'lands their %s callback on the arm that matches it',
      async (label) => {
        const body = theirPayloads[label] as Record<string, unknown>;

        const reading = await deliver(body);

        expect(reading.signatureValid).toBe(true);
        expect(reading.label).toBe(label);
        expect(reading.event).toEqual(expectedArms[label]);
      },
    );

    it('reads every callback type their page publishes', () => {
      // Their own count, so a type added to one table and not the other is a
      // failure here rather than a payload that silently never runs.
      expect(Object.keys(theirPayloads)).toHaveLength(12);
      expect(Object.keys(expectedArms).sort()).toEqual(
        Object.keys(theirPayloads).sort(),
      );
    });

    it('refuses a body altered after it was signed', async () => {
      const body = { ...theirPayloads.RECHARGE };
      const signature = sign(body);

      const reading = await adapter.readCallback({
        payload: { ...body, result: '2' },
        headers: { ...signedHeaders, signature },
      });

      expect(reading.signatureValid).toBe(false);
    });

    it('refuses a signature made with another key', async () => {
      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 1024,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
      const body = { ...theirPayloads.OPERATION };

      const reading = await adapter.readCallback({
        payload: body,
        headers: {
          ...signedHeaders,
          signature: createSign('RSA-SHA256')
            .update(buildHyperCardCanonicalString(signedHeaders, body))
            .sign(privateKey, 'base64'),
        },
      });

      expect(reading.signatureValid).toBe(false);
    });

    it('refuses a delivery carrying no signature at all', async () => {
      const reading = await adapter.readCallback({
        payload: { ...theirPayloads.OPERATION },
        headers: signedHeaders,
      });

      expect(reading.signatureValid).toBe(false);
    });

    it('verifies through the headers they signed and no others', async () => {
      // A real request also carries content-type, host and user-agent, none of
      // which they signed. Feeding them in would fail every legitimate
      // delivery, so this is the case that proves they are dropped.
      const reading = await deliver(
        { ...theirPayloads.CARD_CONFIG_CHANGE },
        {
          'content-type': 'application/json',
          host: 'orchestrator.example.com',
          'user-agent': 'okhttp/4.9.0',
        },
      );

      expect(reading.signatureValid).toBe(true);
    });

    it('accepts a delivery carrying a field it does not recognise', async () => {
      // Their versioning policy: new fields must be ignored rather than
      // rejected. The field takes part in the signature and in the digest and
      // changes nothing else.
      const reading = await deliver({
        ...theirPayloads.CARD_CONFIG_CHANGE,
        something_they_added_later: 'value',
      });

      expect(reading.signatureValid).toBe(true);
      expect(reading.event).toEqual({ kind: 'PRODUCT_CATALOGUE' });
    });

    it('gives one delivery and its retry the same key, headers aside', async () => {
      const body = { ...theirPayloads.CARD_STATUS_CHANGE };

      const first = await deliver(body);
      const retry = await deliver(
        { ...body },
        { timestamp: '1747999999', nonce: 'ffffffffff' },
      );

      // The whole reason the digest excludes headers: a retry may carry a
      // fresh timestamp and nonce, and one that did not collide would be
      // processed a second time.
      expect(retry.deliveryKey).toBe(first.deliveryKey);
      expect(first.deliveryKey).toMatch(/^[0-9a-f]{64}$/);
    });

    it('gives two different bodies different keys', async () => {
      const first = await deliver({ ...theirPayloads.CONSUME });
      const second = await deliver({
        ...theirPayloads.CONSUME,
        tx_id: '20230413145817505391',
      });

      expect(second.deliveryKey).not.toBe(first.deliveryKey);
    });

    it('reads a refused delivery as far as it can', async () => {
      // What a delivery claimed to be is the first thing anyone diagnosing a
      // failed verification wants, so the label and the arm are read either way.
      const reading = await adapter.readCallback({
        payload: { ...theirPayloads.CARD_CONFIG_CHANGE },
        headers: { ...signedHeaders, signature: 'not-a-signature' },
      });

      expect(reading.signatureValid).toBe(false);
      expect(reading.label).toBe('CARD_CONFIG_CHANGE');
      expect(reading.event).toEqual({ kind: 'PRODUCT_CATALOGUE' });
    });

    it('surfaces a key that cannot be read rather than calling it a bad signature', async () => {
      // A malformed key is answered `false` by the verifier and recorded as a
      // refusal, which is diagnosable. A key that is *absent* is our own
      // misconfiguration, and reporting it as their bad signature would send
      // whoever diagnoses it into the signing path instead of into the deploy.
      platformKeyService.resolve.mockRejectedValue(
        new Error('Vault secret "hypercard/platform-public" not found'),
      );

      await expect(deliver({ ...theirPayloads.OPERATION })).rejects.toThrow(
        /hypercard\/platform-public/,
      );
    });

    it('answers with the acknowledgement they count as delivery', () => {
      // Both halves are load-bearing: they treat any status but 200 as a
      // failure, and separately retry anything not answering code=1.
      expect(adapter.callbackAck()).toEqual({
        status: 200,
        body: '{"code":1,"msg":"ok","data":{}}',
        contentType: 'application/json',
      });
    });
  });
});
