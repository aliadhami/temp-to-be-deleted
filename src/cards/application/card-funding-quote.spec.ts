import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { CardProviderIntentRejectedError } from '../domain/card-provider-intent-rejected.error';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { FundingNetwork } from '../domain/funding-network.enum';
import {
  payableFundingAmount,
  requestFundingQuote,
  warnOnQuotedCreditMismatch,
} from './card-funding-quote';

describe('card funding quote helpers', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  describe('payableFundingAmount', () => {
    const owed = { amount: '122.71614508', currencyCode: 'USDT' };

    it('rounds up to what the named chain carries', () => {
      expect(payableFundingAmount(owed, FundingNetwork.TRON)).toEqual({
        amount: '122.716146',
        currencyCode: 'USDT',
        network: FundingNetwork.TRON,
        decimals: 6,
      });
    });

    it('keeps the extra places on a chain that carries them', () => {
      expect(payableFundingAmount(owed, FundingNetwork.BSC)).toEqual({
        amount: '122.71614508',
        currencyCode: 'USDT',
        network: FundingNetwork.BSC,
        decimals: 18,
      });
    });

    it('answers the coarsest precision when no chain is named', () => {
      expect(payableFundingAmount(owed, null)).toEqual({
        amount: '122.716146',
        currencyCode: 'USDT',
        network: null,
        decimals: 6,
      });
    });

    it('leaves an already-payable figure alone', () => {
      expect(
        payableFundingAmount({ amount: '25', currencyCode: 'USDT' }, null)
          ?.amount,
      ).toBe('25');
    });

    it('answers nothing for a coin no supported chain holds', () => {
      expect(
        payableFundingAmount({ amount: '1', currencyCode: 'BTC' }, null),
      ).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('No supported chain holds BTC'),
      );
    });

    it('answers nothing rather than a figure it could not round', () => {
      expect(
        payableFundingAmount({ amount: 'n/a', currencyCode: 'USDT' }, null),
      ).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not round'),
      );
    });
  });

  describe('requestFundingQuote', () => {
    const issuerAnswering = (outcome: unknown) =>
      ({
        quoteCardFunding: jest
          .fn()
          .mockImplementation(() =>
            outcome instanceof Error
              ? Promise.reject(outcome)
              : Promise.resolve(outcome),
          ),
      }) as never;

    const quote = {
      credited: { amount: '100', currencyCode: 'USD' },
      cost: { amount: '102.71614508', currencyCode: 'USDT' },
      fee: { amount: '0.88', currencyCode: 'USDT' },
      quotedAt: '2026-02-03T04:05:06.789Z',
    };

    const ask = (issuer: never) =>
      requestFundingQuote(
        issuer,
        '52400002',
        { depositAmount: '100', currencyCode: 'USD' },
        'amount',
      );

    it('hands back what the issuer answered', async () => {
      await expect(ask(issuerAnswering(quote))).resolves.toEqual(quote);
    });

    it('turns a state refusal into a conflict carrying none of their text', async () => {
      const refused = new CardProviderConflictError(
        CardProviderKey.HYPERCARD,
        'A0010',
        'HyperCard refused card funding estimate: This card does not support recharging',
      );

      await expect(ask(issuerAnswering(refused))).rejects.toMatchObject({
        status: 409,
        cause: refused,
      });
      await expect(ask(issuerAnswering(refused))).rejects.toThrow(
        ConflictException,
      );
      await expect(ask(issuerAnswering(refused))).rejects.not.toThrow(/A0010/);
    });

    it("names the caller's own field rather than the adapter's", async () => {
      const rejected = new CardProviderIntentRejectedError(
        CardProviderKey.HYPERCARD,
        'initialDepositAmount',
        'the issuer would not price this deposit',
      );

      await expect(ask(issuerAnswering(rejected))).rejects.toThrow(
        BadRequestException,
      );
      await expect(ask(issuerAnswering(rejected))).rejects.toThrow(/"amount"/);
      await expect(ask(issuerAnswering(rejected))).rejects.not.toThrow(
        /initialDepositAmount/,
      );
    });

    it('keeps the original refusal reachable on the cause', async () => {
      const rejected = new CardProviderIntentRejectedError(
        CardProviderKey.HYPERCARD,
        'initialDepositAmount',
        'the issuer would not price this deposit',
      );

      await expect(ask(issuerAnswering(rejected))).rejects.toMatchObject({
        cause: rejected,
      });
    });

    it('lets a failure that is not a refusal through unchanged', async () => {
      const failure = new Error('connection reset');

      await expect(ask(issuerAnswering(failure))).rejects.toBe(failure);
    });
  });

  describe('warnOnQuotedCreditMismatch', () => {
    it('warns when the issuer priced a different amount from the one asked about', () => {
      warnOnQuotedCreditMismatch(
        '100',
        { amount: '95', currencyCode: 'USD' },
        'Card card-1',
        'top-up',
      );

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('against a requested top-up of 100'),
      );
    });

    it('stays quiet for a credit written to a different number of places', () => {
      // '100.00000000' is the '100' that was asked for; a textual compare would
      // report every quote as a mismatch.
      warnOnQuotedCreditMismatch(
        '100',
        { amount: '100.00000000', currencyCode: 'USD' },
        'Card card-1',
        'top-up',
      );

      expect(warn).not.toHaveBeenCalled();
    });
  });
});
