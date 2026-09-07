import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { GatewayKey } from '../../domain/gateway-key.enum';
import { PaymentMethod } from '../../domain/payment-method.enum';
import { InitiatePaymentDto } from './initiate-payment.dto';

/**
 * These are money and asset-identity boundaries, so they're pinned rather than
 * left to whoever next edits the regex. `amount` and `currency` were widened
 * for crypto (was: exactly 2 decimals, exactly 3 uppercase letters) — the point
 * of these tests is that the widening did not also let nonsense through.
 */
const baseDto = {
  requestId: 'REQ_1',
  referenceNumber: 'REF-1',
  gatewayKey: GatewayKey.SUNPAY,
  method: PaymentMethod.CRYPTO,
  amount: '10.00',
  currency: 'USDT',
};

const errorsFor = (overrides: Record<string, unknown>): string[] => {
  const dto = plainToInstance(InitiatePaymentDto, {
    ...baseDto,
    ...overrides,
  });
  return validateSync(dto).flatMap((e) => Object.keys(e.constraints ?? {}));
};

const fieldFails = (field: string, value: unknown): boolean =>
  validateSync(
    plainToInstance(InitiatePaymentDto, { ...baseDto, [field]: value }),
  ).some((e) => e.property === field);

describe('InitiatePaymentDto', () => {
  it('accepts the baseline crypto payload', () => {
    expect(errorsFor({})).toHaveLength(0);
  });

  describe('amount', () => {
    it.each([
      '10.00', // legacy fiat form still valid
      '10', // fractional part now optional
      '0.00000001', // 1 satoshi (BTC, 8dp)
      '0.000000000000000001', // 1 wei (ETH, 18dp)
      '15.750', // 3dp — KWD/BHD/OMR
      '99999999999999999999', // 20 integer digits
    ])('accepts %s', (amount) => {
      expect(fieldFails('amount', amount)).toBe(false);
    });

    it.each([
      ['negative', '-10.00'],
      ['19 decimals — beyond our scale', '1.0000000000000000001'],
      ['21 integer digits', '999999999999999999999'],
      ['scientific notation', '1e3'],
      ['comma decimal separator', '10,00'],
      ['trailing dot', '10.'],
      ['leading dot', '.10'],
      ['empty', ''],
      ['not a number', 'abc'],
      ['whitespace padded', ' 10.00 '],
    ])('rejects %s', (_label, amount) => {
      expect(fieldFails('amount', amount)).toBe(true);
    });

    it('rejects a JSON number — amount must arrive as a string', () => {
      // A float cannot represent crypto amounts exactly, so the contract is
      // string-only. class-validator's @Matches fails on a non-string.
      expect(fieldFails('amount', 10.0)).toBe(true);
    });
  });

  describe('currency', () => {
    it.each(['AED', 'USD', 'USDT', 'TRC20_USDT', 'BTC'])(
      'accepts %s',
      (currency) => {
        expect(fieldFails('currency', currency)).toBe(false);
      },
    );

    it.each([
      ['lowercase', 'usdt'],
      ['too short', 'US'],
      ['over 20 chars', 'A'.repeat(21)],
      ['hyphen', 'TRC20-USDT'],
      ['empty', ''],
    ])('rejects %s', (_label, currency) => {
      expect(fieldFails('currency', currency)).toBe(true);
    });
  });

  describe('chainType', () => {
    it('is optional', () => {
      expect(fieldFails('chainType', undefined)).toBe(false);
    });

    // Every chain SunPay documents for USDT/USDC, verified against their API as
    // recognised pairs. Note the mixed case — these are the exact spellings.
    it.each([
      'TRON',
      'Ethereum',
      'BNBSmartChain',
      'Aptos',
      'Solana',
      'PolygonPOS',
      'ArbitrumOne',
    ])('accepts the SunPay chain %s', (chainType) => {
      expect(fieldFails('chainType', chainType)).toBe(false);
    });

    it('accepts mixed case, because provider chain ids are case-sensitive', () => {
      // Confirmed against SunPay: "Ethereum" is valid while "ETHEREUM" and
      // "ethereum" both return 40001. So this field must NOT be normalised, and
      // validation must not demand a single case.
      expect(fieldFails('chainType', 'Ethereum')).toBe(false);
      expect(fieldFails('chainType', 'ETHEREUM')).toBe(false);
      expect(fieldFails('chainType', 'ethereum')).toBe(false);
    });

    it.each([
      ['single char', 'T'],
      ['hyphen', 'TRON-MAIN'],
      ['underscore', 'BNB_SMART_CHAIN'],
      ['space', 'Polygon POS'],
      ['empty', ''],
      ['over 30 chars', 'A'.repeat(31)],
    ])('rejects %s', (_label, chainType) => {
      expect(fieldFails('chainType', chainType)).toBe(true);
    });
  });
});
