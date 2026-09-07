import { BadRequestException, Logger } from '@nestjs/common';
import { assertDepositAmountWithinLimits } from './card-deposit-limits';
import { CardDepositProduct } from './card-product-resolver';

describe('assertDepositAmountWithinLimits', () => {
  const product = (
    overrides: Partial<CardDepositProduct> = {},
  ): CardDepositProduct => ({
    publicId: 'product-1',
    providerProductId: '52400002',
    currencyCode: 'USD',
    depositMinPerTransaction: '10',
    depositMaxPerTransaction: '100000',
    ...overrides,
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('admits an amount inside the bounds', () => {
    expect(() =>
      assertDepositAmountWithinLimits('25.00', product()),
    ).not.toThrow();
  });

  it.each([['10'], ['100000']])('admits %s, exactly on a bound', (amount) => {
    expect(() =>
      assertDepositAmountWithinLimits(amount, product()),
    ).not.toThrow();
  });

  it('refuses an amount a hundredth below the minimum', () => {
    expect(() =>
      assertDepositAmountWithinLimits('9.99999999', product()),
    ).toThrow(BadRequestException);
  });

  it('refuses an amount above the maximum', () => {
    expect(() =>
      assertDepositAmountWithinLimits('100000.00000001', product()),
    ).toThrow(BadRequestException);
  });

  it('names the bound and the currency it is stated in', () => {
    expect(() => assertDepositAmountWithinLimits('1', product())).toThrow(
      'at least 10 USD',
    );
  });

  it.each([
    ['minimum', { depositMinPerTransaction: 'n/a' }],
    ['maximum', { depositMaxPerTransaction: 'n/a' }],
  ])(
    'refuses rather than checking against an unreadable %s',
    (_which, overrides) => {
      expect(() =>
        assertDepositAmountWithinLimits('25.00', product(overrides)),
      ).toThrow('cannot read');
    },
  );

  it('admits any amount when the product states no bounds', () => {
    expect(() =>
      assertDepositAmountWithinLimits(
        '1',
        product({
          depositMinPerTransaction: null,
          depositMaxPerTransaction: null,
        }),
      ),
    ).not.toThrow();
  });

  it('admits any amount when no product could be reached', () => {
    expect(() => assertDepositAmountWithinLimits('1', null)).not.toThrow();
  });
});
