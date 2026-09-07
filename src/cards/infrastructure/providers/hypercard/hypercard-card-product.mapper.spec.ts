import { Logger } from '@nestjs/common';
import { CardLifecycleOperation } from '../../../domain/card-lifecycle-operation.enum';
import { CardMaterial } from '../../../domain/card-material.enum';
import { CardOrganisation } from '../../../domain/card-organisation.enum';
import { CardProductActivationMode } from '../../../domain/card-product-activation-mode.enum';
import { CardProductApplicationMode } from '../../../domain/card-product-application-mode.enum';
import { CardProductSensitiveDetailMode } from '../../../domain/card-product-sensitive-detail-mode.enum';
import { CardProduct } from '../../../domain/card-product.model';
import { CardType } from '../../../domain/card-type.enum';
import {
  mapHyperCardCardProduct,
  mapHyperCardCardProducts,
} from './hypercard-card-product.mapper';
import { HyperCardCardProductRow } from './hypercard.types';

/**
 * Their own example response from their "Card config list" page, copied
 * verbatim — including the fields this mapper does not read, which is what
 * proves it ignores them rather than choking on them.
 */
const THEIR_EXAMPLE_ROW = {
  activate_type: '1',
  apply_pay_coin: '["usdt","btc","eth","hbt"]',
  apply_type: '1',
  card_coin: 'usd',
  card_fee: '100.00000000',
  card_org: '1',
  card_sub_type: '1',
  card_type: '1',
  card_type_id: '40000002',
  china_postage: '100.02',
  kyc_nationality_limit: '1',
  max_recharge_amount: '100000.00000000',
  max_single_recharge_amount: '1000.00000000',
  min_single_recharge_amount: '10.00000000',
  min_first_recharge_amount: '100.00',
  need_first_recharge: 1,
  non_china_postage: '10.02',
  recharge_fee: '0.02800000',
  recharge_pay_coin: '["usdt","btc"]',
  support_business: '1,2,3',
  support_refund: '0',
  more_card: 1,
  can_recharge: 1,
  card_detail_obtain_way: 1,
  kyc_country_limit: '1,2,3,4',
  doc_type: '1,2',
  can_repeat: 1,
  status: 1,
  black_list_types: [
    {
      black_list_type: 'online pay',
      black_list_details: [
        {
          black_list_name: 'alipay',
          black_list_image: 'https://example.invalid/logo.png',
        },
      ],
    },
  ],
  need_aml_report: 1,
  aml_type: 1,
  need_poa: 1,
  support_poa_type: '1,2',
  kyc_nationality_limit_id: '1,2',
  annual_fee: '0.00000000',
  kyc_country_limit_short: 'CN,US',
  kyc_nationality_limit_short: 'CN,US',
  multiple_boolean_config: 1,
};

/** A minimal readable row, for tests that vary one field at a time. */
const row = (
  overrides: Partial<HyperCardCardProductRow> = {},
): HyperCardCardProductRow => ({
  card_type_id: '40000002',
  card_type: 1,
  card_org: 1,
  apply_type: 2,
  activate_type: 2,
  card_coin: 'usd',
  ...overrides,
});

describe('hypercard-card-product.mapper', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('their own example response', () => {
    it('normalises every field this mapper reads', () => {
      const product = mapHyperCardCardProduct(THEIR_EXAMPLE_ROW);

      // `satisfies` rather than a bare literal: the adapter mocks elsewhere are
      // untyped, so without it a drifting domain model would let this assertion
      // keep passing against a shape nothing else has.
      expect(product).toStrictEqual({
        providerProductId: '40000002',
        displayName: 'Visa Virtual USD',
        cardType: CardType.VIRTUAL,
        cardOrganisation: CardOrganisation.VISA,
        material: CardMaterial.METAL,
        currencyCode: 'USD',
        fees: {
          issuance: { amount: '100.00000000', currencyCode: 'USDT' },
          // Their example publishes `annual_fee: "0.00000000"` — free, not a
          // fee of zero.
          annual: null,
          depositFeePercent: '2.800000',
        },
        depositLimits: {
          minPerTransaction: '10.00000000',
          maxPerTransaction: '1000.00000000',
          maxPerDay: '100000.00000000',
          requiresInitialDeposit: true,
          minInitialDeposit: '100.00',
        },
        applicationMode: CardProductApplicationMode.FULL_KYC,
        requiresKyc: true,
        activation: {
          mode: CardProductActivationMode.ISSUER_REQUEST,
          requiresIdentityDocument: true,
        },
        // Their own example publishes obtain way 1 on this row.
        sensitiveDetailMode: CardProductSensitiveDetailMode.HOSTED_PAGE,
        availableForIssuance: true,
        supportedOperations: [
          CardLifecycleOperation.BLOCK,
          CardLifecycleOperation.UNBLOCK,
          CardLifecycleOperation.REPORT_LOSS,
        ],
      } satisfies CardProduct);
      expect(warn).not.toHaveBeenCalled();
    });

    it('pairs their virtual card type with their metal material rather than nulling it', () => {
      // Their example does exactly this, which is why `material: null` means
      // "the issuer publishes none" and never "this one is virtual".
      const product = mapHyperCardCardProduct(THEIR_EXAMPLE_ROW);

      expect(product?.cardType).toBe(CardType.VIRTUAL);
      expect(product?.material).toBe(CardMaterial.METAL);
    });
  });

  describe('type coercion', () => {
    // Their parameter table declares these integers and their own example
    // returns them as strings, in the same payload where four other integer
    // fields come back as numbers. Both forms have to land in the same place.
    it.each([
      ['string', '1'],
      ['number', 1],
    ])('reads their card type as a %s', (_form, value) => {
      expect(mapHyperCardCardProduct(row({ card_type: value }))?.cardType).toBe(
        CardType.VIRTUAL,
      );
    });

    it.each([
      ['string', '2'],
      ['number', 2],
    ])('reads their card organisation as a %s', (_form, value) => {
      expect(
        mapHyperCardCardProduct(row({ card_org: value }))?.cardOrganisation,
      ).toBe(CardOrganisation.MASTERCARD);
    });

    it.each([
      ['string', '2'],
      ['number', 2],
    ])('reads their application type as a %s', (_form, value) => {
      expect(
        mapHyperCardCardProduct(row({ apply_type: value }))?.applicationMode,
      ).toBe(CardProductApplicationMode.NO_KYC);
    });

    it.each([
      ['string', '2'],
      ['number', 2],
    ])('reads their activation method as a %s', (_form, value) => {
      expect(
        mapHyperCardCardProduct(row({ activate_type: value }))?.activation,
      ).toStrictEqual({ mode: CardProductActivationMode.CARDHOLDER_DIRECT });
    });

    it.each([
      ['string', '1'],
      ['number', 1],
    ])('reads their initial-deposit flag as a %s', (_form, value) => {
      expect(
        mapHyperCardCardProduct(row({ need_first_recharge: value }))
          ?.depositLimits.requiresInitialDeposit,
      ).toBe(true);
    });

    it.each([
      ['string', '0'],
      ['number', 0],
    ])('reads their detail-obtain way as a %s', (_form, value) => {
      // Not hypothetical for this field: the live account sends it as an
      // integer while their page declares one and their example quotes it.
      expect(
        mapHyperCardCardProduct(row({ card_detail_obtain_way: value }))
          ?.sensitiveDetailMode,
      ).toBe(CardProductSensitiveDetailMode.API);
    });
  });

  describe('their detail-obtain way', () => {
    it.each([
      [0, CardProductSensitiveDetailMode.API],
      [1, CardProductSensitiveDetailMode.HOSTED_PAGE],
      [2, CardProductSensitiveDetailMode.CARDHOLDER_DIRECT],
    ])('maps their %s to %s', (value, expected) => {
      expect(
        mapHyperCardCardProduct(row({ card_detail_obtain_way: value }))
          ?.sensitiveDetailMode,
      ).toBe(expected);
    });

    it('names their email delivery for what it means rather than for the channel', () => {
      // An issuer using SMS or a portal link means the same thing, and this
      // enum is published to partners — the same reasoning that named the
      // activation mode.
      expect(
        mapHyperCardCardProduct(row({ card_detail_obtain_way: 2 }))
          ?.sensitiveDetailMode,
      ).toBe(CardProductSensitiveDetailMode.CARDHOLDER_DIRECT);
    });

    it('leaves an unrecognised value unknown and still lists the product', () => {
      // **The one unknown branch here that does not exclude.** Every other code
      // this mapper resolves decides whether a card can be opened at all; this
      // one describes how a card will later be read, and a product that can
      // still be sold should not vanish from the catalogue over it.
      const product = mapHyperCardCardProduct(
        row({ card_detail_obtain_way: 7 }),
      );

      expect(product).not.toBeNull();
      expect(product?.sensitiveDetailMode).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('unrecognised card_detail_obtain_way "7"'),
      );
    });

    it('leaves an absent value unknown without warning about it', () => {
      // Their update log dates this field after the endpoint shipped, so a
      // payload without it predates the field rather than declining it. The
      // base row carries no obtain way, which is the absence under test.
      const product = mapHyperCardCardProduct(row());

      expect(product?.sensitiveDetailMode).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('their enum appendices', () => {
    it.each<[number, CardType]>([
      [1, CardType.VIRTUAL],
      [2, CardType.PHYSICAL],
    ])('maps their bank card type %i', (code, expected) => {
      expect(mapHyperCardCardProduct(row({ card_type: code }))?.cardType).toBe(
        expected,
      );
    });

    it.each<[number, CardOrganisation]>([
      [1, CardOrganisation.VISA],
      [2, CardOrganisation.MASTERCARD],
      [3, CardOrganisation.AMERICAN_EXPRESS],
      [4, CardOrganisation.UNIONPAY],
      // Their page spells this one "Disconver".
      [5, CardOrganisation.DISCOVER],
      [6, CardOrganisation.JCB],
    ])('maps their card organisation %i', (code, expected) => {
      expect(
        mapHyperCardCardProduct(row({ card_org: code }))?.cardOrganisation,
      ).toBe(expected);
    });

    it.each<[number, CardMaterial]>([
      [1, CardMaterial.METAL],
      [2, CardMaterial.PLASTIC],
    ])('maps their card material %i', (code, expected) => {
      expect(
        mapHyperCardCardProduct(row({ card_sub_type: code }))?.material,
      ).toBe(expected);
    });

    it('maps an absent card material to null without warning', () => {
      // Absent is a documented state — the issuer publishes no material.
      expect(mapHyperCardCardProduct(row())?.material).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    });

    it.each<[number, CardProductApplicationMode]>([
      [1, CardProductApplicationMode.FULL_KYC],
      [2, CardProductApplicationMode.NO_KYC],
      [3, CardProductApplicationMode.PREISSUED_CARD],
      [4, CardProductApplicationMode.KYC_WITH_BILLING_ADDRESS],
      [5, CardProductApplicationMode.ONLINE_KYC],
    ])('maps their application type %i', (code, expected) => {
      expect(
        mapHyperCardCardProduct(row({ apply_type: code }))?.applicationMode,
      ).toBe(expected);
    });

    it.each<[number, boolean]>([
      [1, true],
      // Their Express mode is the only application whose request carries no KYC
      // container at all.
      [2, false],
      [3, true],
      [4, true],
      [5, true],
    ])(
      'keeps requiresKyc agreeing with the application mode for their type %i',
      (code, expected) => {
        expect(
          mapHyperCardCardProduct(row({ apply_type: code }))?.requiresKyc,
        ).toBe(expected);
      },
    );

    it('maps their activation method 1 to an issuer request needing a document', () => {
      expect(
        mapHyperCardCardProduct(row({ activate_type: 1 }))?.activation,
      ).toStrictEqual({
        mode: CardProductActivationMode.ISSUER_REQUEST,
        requiresIdentityDocument: true,
      });
    });

    it('maps their activation method 2 to the cardholder acting directly', () => {
      expect(
        mapHyperCardCardProduct(row({ activate_type: 2 }))?.activation,
      ).toStrictEqual({ mode: CardProductActivationMode.CARDHOLDER_DIRECT });
    });

    it('maps their activation method 3 to an issuer request needing no document', () => {
      // The one their docs describe no endpoint for: their Activation page says
      // it should only be called when the activation method is 1, and their
      // "Key Business Processes" page repeats it. A product here is observed,
      // not activated.
      expect(
        mapHyperCardCardProduct(row({ activate_type: 3 }))?.activation,
      ).toStrictEqual({
        mode: CardProductActivationMode.ISSUER_REQUEST,
        requiresIdentityDocument: false,
      });
    });
  });

  describe('supported operations', () => {
    const operations = (support_business?: string | number) =>
      mapHyperCardCardProduct(
        support_business === undefined ? row() : row({ support_business }),
      )?.supportedOperations;

    it('maps the two operations our one live product publishes', () => {
      expect(operations('1,2')).toStrictEqual([
        CardLifecycleOperation.BLOCK,
        CardLifecycleOperation.UNBLOCK,
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps their order rather than a canonical one', () => {
      expect(operations('2,1')).toStrictEqual([
        CardLifecycleOperation.UNBLOCK,
        CardLifecycleOperation.BLOCK,
      ]);
    });

    it.each<[string, string | number | undefined]>([
      ['absent', undefined],
      ['empty', ''],
      ['whitespace', '   '],
    ])(
      'reads an %s list as no operations rather than every operation',
      (_label, value) => {
        expect(operations(value)).toStrictEqual([]);
        expect(warn).not.toHaveBeenCalled();
      },
    );

    it('reads a single code sent as a number', () => {
      // Their page declares this field a string; other fields on the same row
      // arrive as the opposite type from their documentation.
      expect(operations(1)).toStrictEqual([CardLifecycleOperation.BLOCK]);
    });

    it.each<[number, CardLifecycleOperation]>([
      [1, CardLifecycleOperation.BLOCK],
      [2, CardLifecycleOperation.UNBLOCK],
      [3, CardLifecycleOperation.REPORT_LOSS],
      [4, CardLifecycleOperation.RESET_PASSWORD],
      [5, CardLifecycleOperation.REISSUE],
      [6, CardLifecycleOperation.CHANGE_PIN],
      [9, CardLifecycleOperation.CANCEL],
    ])('maps their operation code %i', (code, expected) => {
      expect(operations(String(code))).toStrictEqual([expected]);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each<[string, string]>([
      ['a code outside their appendix', '1,8'],
      ['a code in the gap their numbering leaves', '1,7'],
      ['a member that is not a number', '1,abc'],
    ])('drops %s and keeps the product', (_label, value) => {
      expect(operations(value)).toStrictEqual([CardLifecycleOperation.BLOCK]);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('names the dropped code in the warning', () => {
      operations('1,8');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"8"'));
    });

    it('publishes a repeated code once', () => {
      expect(operations('1,1')).toStrictEqual([CardLifecycleOperation.BLOCK]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('says nothing about an empty member, which names no code', () => {
      expect(operations('1,,2,')).toStrictEqual([
        CardLifecycleOperation.BLOCK,
        CardLifecycleOperation.UNBLOCK,
      ]);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('the unknown branch', () => {
    // Never a guessed default: a fabricated card network or application mode
    // would be published to a partner as fact and then applied for.
    it.each<[string, Partial<HyperCardCardProductRow>]>([
      ['card type', { card_type: 9 }],
      ['card organisation', { card_org: 9 }],
      ['card material', { card_sub_type: 9 }],
      ['application type', { apply_type: 9 }],
      ['activation method', { activate_type: 9 }],
    ])('excludes a product with an unrecognised %s', (_field, override) => {
      expect(mapHyperCardCardProduct(row(override))).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('excludes a product carrying no card type id', () => {
      // Spelled out rather than overridden with `undefined`: under
      // `exactOptionalPropertyTypes` an explicit undefined is not the same as
      // an absent key, and absent is the shape their wire would produce.
      const withoutId: HyperCardCardProductRow = {
        card_type: 1,
        card_org: 1,
        apply_type: 2,
        activate_type: 2,
        card_coin: 'usd',
      };

      expect(mapHyperCardCardProduct(withoutId)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('excludes a product carrying no card currency', () => {
      expect(mapHyperCardCardProduct(row({ card_coin: '   ' }))).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('excludes a product whose codes are not integers at all', () => {
      expect(mapHyperCardCardProduct(row({ card_org: 'visa' }))).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('fees', () => {
    it('shifts their recharge fee two decimal places rather than multiplying', () => {
      // Their page: "if this value is 0.02, it means 2%". Their own sample
      // value, and the reason this is string surgery — 0.028 * 100 is
      // 2.8000000000000003.
      expect(
        mapHyperCardCardProduct(row({ recharge_fee: '0.02800000' }))?.fees
          .depositFeePercent,
      ).toBe('2.800000');
    });

    it.each([
      ['0.02800000', '2.800000'],
      ['0.5', '50'],
      ['0.001', '0.1'],
      ['1', '100'],
      ['0.12345678', '12.345678'],
    ])('shifts %s to %s', (published, expected) => {
      expect(
        mapHyperCardCardProduct(row({ recharge_fee: published }))?.fees
          .depositFeePercent,
      ).toBe(expected);
    });

    it.each([
      ['issuance', 'card_fee'],
      ['annual', 'annual_fee'],
    ] as const)('reads the %s fee in usdt', (fee, field) => {
      // Their page documents both as "in usdt", which is not the card's own
      // currency — this product is denominated in usd.
      expect(
        mapHyperCardCardProduct(row({ [field]: '12.34000000' }))?.fees[fee],
      ).toStrictEqual({ amount: '12.34000000', currencyCode: 'USDT' });
    });

    it.each([
      ['issuance', 'card_fee'],
      ['annual', 'annual_fee'],
    ] as const)(
      'reads a published zero %s fee the same as an absent one',
      (fee, field) => {
        expect(
          mapHyperCardCardProduct(row({ [field]: '0.00000000' }))?.fees[fee],
        ).toBeNull();
        expect(mapHyperCardCardProduct(row())?.fees[fee]).toBeNull();
      },
    );

    it('reads a published zero recharge fee as free', () => {
      expect(
        mapHyperCardCardProduct(row({ recharge_fee: '0.00000000' }))?.fees
          .depositFeePercent,
      ).toBeNull();
    });

    it('ignores an amount that is not a decimal string', () => {
      expect(
        mapHyperCardCardProduct(row({ card_fee: 'free' }))?.fees.issuance,
      ).toBeNull();
    });

    it('reads a numeric amount instead of crashing on it', () => {
      // Their spec asks for amount strings and their sandbox honours it, but
      // nothing on the wire enforces it — and every integer field on this
      // endpoint has already come back both ways. A `.trim()` on a number
      // would take down the whole catalogue rather than one field.
      expect(
        mapHyperCardCardProduct(row({ card_fee: 20 }))?.fees.issuance,
      ).toStrictEqual({ amount: '20', currencyCode: 'USDT' });
    });

    it('reads a numeric recharge fee', () => {
      expect(
        mapHyperCardCardProduct(row({ recharge_fee: 0.015 }))?.fees
          .depositFeePercent,
      ).toBe('1.5');
    });

    it.each([
      ['a negative fee', { card_fee: '-100.00' }],
      ['a non-finite number', { card_fee: Number.NaN }],
    ])('refuses %s', (_case, override) => {
      // Their docs publish no negative amount anywhere, so one arriving is a
      // payload we do not understand — and a negative price would otherwise
      // reach a partner as the cost of a card.
      expect(mapHyperCardCardProduct(row(override))?.fees.issuance).toBeNull();
    });

    it('refuses a negative deposit limit', () => {
      expect(
        mapHyperCardCardProduct(row({ max_recharge_amount: '-1' }))
          ?.depositLimits.maxPerDay,
      ).toBeNull();
    });
  });

  describe('deposit limits', () => {
    it('keeps a published zero limit rather than reading it as no limit', () => {
      // Unlike a fee: the domain model states that a null limit means the
      // issuer publishes none, which is not the same as a limit of zero.
      expect(
        mapHyperCardCardProduct(
          row({ min_single_recharge_amount: '0.00000000' }),
        )?.depositLimits.minPerTransaction,
      ).toBe('0.00000000');
    });

    it('reads an absent limit as none', () => {
      expect(mapHyperCardCardProduct(row())?.depositLimits).toStrictEqual({
        minPerTransaction: null,
        maxPerTransaction: null,
        maxPerDay: null,
        requiresInitialDeposit: false,
        minInitialDeposit: null,
      });
    });
  });

  describe('availability for issuance', () => {
    it.each<[string, Partial<HyperCardCardProductRow>, boolean]>([
      ['both flags set', { status: 1, can_recharge: 1 }, true],
      ['a disabled card type', { status: 0, can_recharge: 1 }, false],
      // Their page: when recharge is unsupported "the card cannot be recharged
      // and card opening application is not allowed".
      ['recharge unsupported', { status: 1, can_recharge: 0 }, false],
      ['both flags absent', {}, true],
      ['an unreadable flag', { status: 'yes' }, false],
    ])('is %s → %s', (_case, override, expected) => {
      expect(mapHyperCardCardProduct(row(override))?.availableForIssuance).toBe(
        expected,
      );
    });
  });

  describe('displayName', () => {
    it.each<[Partial<HyperCardCardProductRow>, string]>([
      [{ card_org: 1, card_type: 1, card_coin: 'usd' }, 'Visa Virtual USD'],
      [
        { card_org: 2, card_type: 2, card_coin: 'usdt' },
        'Mastercard Physical USDT',
      ],
      [
        { card_org: 3, card_type: 1, card_coin: 'eur' },
        'American Express Virtual EUR',
      ],
      [{ card_org: 4, card_type: 1, card_coin: 'usd' }, 'UnionPay Virtual USD'],
      [{ card_org: 6, card_type: 1, card_coin: 'usd' }, 'JCB Virtual USD'],
    ])('composes %o as "%s"', (override, expected) => {
      // Their response carries no name, title or label field of any kind, so
      // this is composed rather than read — network, form, currency.
      expect(mapHyperCardCardProduct(row(override))?.displayName).toBe(
        expected,
      );
    });

    it('leaves the material out of the name', () => {
      // It means nothing for a virtual card, and their own example pairs a
      // metal material with a virtual card type.
      expect(
        mapHyperCardCardProduct(row({ card_sub_type: 1 }))?.displayName,
      ).toBe('Visa Virtual USD');
    });
  });

  describe('mapHyperCardCardProducts', () => {
    it('maps an empty catalogue to an empty list without warning', () => {
      expect(mapHyperCardCardProducts([])).toStrictEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([
      ['an object', { card_type_id: '1' }],
      ['a bare string', 'ok'],
      ['a number', 7],
    ])('treats %s as an empty catalogue and warns', (_case, data) => {
      // Their envelope carries an array here and a bare string on their
      // cipherkey-app token endpoint, and nothing validates the payload
      // against the type argument — iterating one of these would be an
      // untyped `is not iterable` crash rather than a mapping failure.
      expect(mapHyperCardCardProducts(data)).toStrictEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
    ])('treats %s as an empty catalogue without warning', (_case, data) => {
      // No payload at all is a documented success on their side — a merchant
      // with no products — so it is not worth a warning.
      expect(mapHyperCardCardProducts(data)).toStrictEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('drops the unreadable rows and keeps the rest', () => {
      const listings = mapHyperCardCardProducts([
        row({ card_type_id: 'A' }),
        row({ card_type_id: 'B', card_org: 9 }),
        row({ card_type_id: 'C' }),
      ]);

      expect(
        listings.map((listing) => listing.product.providerProductId),
      ).toStrictEqual(['A', 'C']);
    });

    it('pairs each product with the row it was normalised from', () => {
      const [listing] = mapHyperCardCardProducts([THEIR_EXAMPLE_ROW]);

      expect(listing?.rawPayload).toStrictEqual(THEIR_EXAMPLE_ROW);
    });

    it('retains the fields the normaliser drops', () => {
      // The whole point of carrying the raw half: their page publishes far more
      // per product than the domain type models, and this is where the rest
      // survives a normalisation that is lossy by design.
      const [listing] = mapHyperCardCardProducts([THEIR_EXAMPLE_ROW]);

      expect(listing?.rawPayload).toMatchObject({
        need_aml_report: 1,
        need_poa: 1,
        doc_type: '1,2',
        can_repeat: 1,
        more_card: 1,
        china_postage: '100.02',
        support_business: '1,2,3',
      });
    });

    it('deep-copies the row rather than aliasing it', () => {
      // A snapshot, not a view: this payload is persisted and replayed later,
      // and their rows nest — a shallow copy would leave `black_list_types`
      // aliased to the parsed response, so mutating it there would silently
      // rewrite what we stored.
      const source = JSON.parse(
        JSON.stringify(THEIR_EXAMPLE_ROW),
      ) as typeof THEIR_EXAMPLE_ROW;
      const [listing] = mapHyperCardCardProducts([source]);

      expect(listing?.rawPayload).not.toBe(source);
      expect(listing?.rawPayload.black_list_types).not.toBe(
        source.black_list_types,
      );

      source.black_list_types[0]!.black_list_type = 'mutated';
      expect(listing?.rawPayload).toStrictEqual(THEIR_EXAMPLE_ROW);
    });

    it('drops a row repeating an id another row already carries', () => {
      // Two rows with one handle would upsert onto the same natural key, so
      // the later would silently overwrite the earlier and a partner would see
      // whichever came last.
      const listings = mapHyperCardCardProducts([
        row({ card_type_id: 'A', card_coin: 'usd' }),
        row({ card_type_id: 'A', card_coin: 'eur' }),
        row({ card_type_id: 'B' }),
      ]);

      expect(
        listings.map((listing) => listing.product.providerProductId),
      ).toStrictEqual(['A', 'B']);
      expect(listings[0]?.product.currencyCode).toBe('USD');
    });

    it('drops the raw payload of an excluded row along with the product', () => {
      expect(mapHyperCardCardProducts([row({ card_org: 9 })])).toStrictEqual(
        [],
      );
    });

    it('logs how many products it excluded', () => {
      mapHyperCardCardProducts([row({ card_org: 9 }), row()]);

      // One warning for the row, one summary — the per-row warnings are easy to
      // miss and a catalogue one product short looks like a complete one.
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenLastCalledWith(
        expect.stringContaining('Excluded 1 of 2') as unknown as string,
      );
    });
  });
});
