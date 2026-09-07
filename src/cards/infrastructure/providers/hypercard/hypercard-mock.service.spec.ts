import { ForbiddenException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { CardProviderConflictError } from '../../../domain/card-provider-conflict.error';
import { HyperCardHttpClient } from './hypercard-http-client.service';
import { HyperCardMockService } from './hypercard-mock.service';
import { HyperCardApiError } from './hypercard-response.util';

describe('HyperCardMockService', () => {
  let service: HyperCardMockService;
  let httpClient: {
    post: jest.Mock;
    postForAck: jest.Mock;
    postForOptionalData: jest.Mock;
  };
  let configService: { getOrThrow: jest.Mock };

  beforeEach(async () => {
    httpClient = {
      post: jest.fn(),
      postForAck: jest.fn(),
      postForOptionalData: jest.fn(),
    };
    configService = { getOrThrow: jest.fn(() => 'sandbox') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HyperCardMockService,
        { provide: HyperCardHttpClient, useValue: httpClient },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(HyperCardMockService);
    jest.clearAllMocks();
    configService.getOrThrow.mockReturnValue('sandbox');
  });

  // Their mock pages all state the endpoints do not exist in production. Every
  // method must refuse before it reaches the transport, not after.
  describe('the sandbox gate', () => {
    beforeEach(() => {
      configService.getOrThrow.mockReturnValue('production');
    });

    const expectRefusedWithoutCalling = async (
      call: () => Promise<unknown>,
    ): Promise<void> => {
      await expect(call()).rejects.toThrow(ForbiddenException);
      expect(httpClient.post).not.toHaveBeenCalled();
      expect(httpClient.postForAck).not.toHaveBeenCalled();
      expect(httpClient.postForOptionalData).not.toHaveBeenCalled();
    };

    it('refuses mockTxConsume', async () => {
      await expectRefusedWithoutCalling(() =>
        service.mockTxConsume({
          cardId: '00003454323400000028888',
          description: 'consume mock',
          fee: '0',
          transactionDate: '1595497477',
          txAmount: '2.5',
          txAmountUsd: '2.5',
        }),
      );
    });

    it('refuses mock3dsTx', async () => {
      await expectRefusedWithoutCalling(() =>
        service.mock3dsTx({
          cardId: '00003454323400000028888',
          txnAmount: '2.5',
        }),
      );
    });

    it('refuses mockBindingData', async () => {
      await expectRefusedWithoutCalling(() =>
        service.mockBindingData('6000005'),
      );
    });

    it('refuses mockAddBalance', async () => {
      await expectRefusedWithoutCalling(() => service.mockAddBalance());
    });

    it('refuses mockTxResend', async () => {
      await expectRefusedWithoutCalling(() =>
        service.mockTxResend(
          '00003454323400000028888',
          '2023101610280651702869308',
        ),
      );
    });

    it('reads the HyperCard environment, not the process environment', () => {
      void service.mockAddBalance().catch(() => undefined);
      expect(configService.getOrThrow).toHaveBeenCalledWith(
        'PAYMENTS_HYPERCARD_ENV',
      );
    });

    it('refuses an environment it does not recognise', async () => {
      configService.getOrThrow.mockReturnValue('staging');

      await expectRefusedWithoutCalling(() =>
        service.mockTxConsume({
          cardId: '00003454323400000028888',
          description: 'consume mock',
          fee: '0',
          transactionDate: '1595497477',
          txAmount: '2.5',
          txAmountUsd: '2.5',
        }),
      );
    });
  });

  describe('mockTxConsume', () => {
    // Field-for-field their "Mock tx consume" example request.
    it('sends their documented payload and defaults type and status', async () => {
      const result = await service.mockTxConsume({
        cardId: '00003454323400000028888',
        description: 'consume mock',
        fee: '0',
        transactionDate: '1595497477',
        txAmount: '2.5',
        txAmountUsd: '2.5',
      });

      expect(httpClient.postForAck).toHaveBeenCalledWith(
        'mock transaction consume',
        '/openapi/card/mock/tx/consume',
        {
          card_id: '00003454323400000028888',
          description: 'consume mock',
          fee: '0',
          transaction_date: '1595497477',
          tx_amount: '2.5',
          tx_amount_usd: '2.5',
          type: 1,
          status: 1,
        },
      );
      expect(result).toEqual({
        cardId: '00003454323400000028888',
        type: 1,
        status: 1,
      });
    });

    it('translates their client error into a provider conflict', async () => {
      httpClient.postForAck.mockRejectedValueOnce(
        new HyperCardApiError(
          200,
          'A0000',
          'The current card status is [Freeze] and the current operation [mock tx] is not allowed',
        ),
      );

      await expect(
        service.mockTxConsume({
          cardId: '00003454323400000028888',
          description: 'consume mock',
          fee: '0',
          transactionDate: '1595497477',
          txAmount: '2.5',
          txAmountUsd: '2.5',
        }),
      ).rejects.toBeInstanceOf(CardProviderConflictError);
    });

    it('translates a card they do not hold into a provider conflict', async () => {
      httpClient.postForAck.mockRejectedValueOnce(
        new HyperCardApiError(200, 'A0004', 'Card no existed'),
      );

      await expect(
        service.mockTxConsume({
          cardId: '00003454323400000028888',
          description: 'consume mock',
          fee: '0',
          transactionDate: '1595497477',
          txAmount: '2.5',
          txAmountUsd: '2.5',
        }),
      ).rejects.toBeInstanceOf(CardProviderConflictError);
    });

    it('leaves a code it cannot account for alone', async () => {
      httpClient.postForAck.mockRejectedValueOnce(
        // Their signature error: our fault or theirs, and not a refusal.
        new HyperCardApiError(200, 'A0001', 'Signature error'),
      );

      await expect(
        service.mockTxConsume({
          cardId: '00003454323400000028888',
          description: 'consume mock',
          fee: '0',
          transactionDate: '1595497477',
          txAmount: '2.5',
          txAmountUsd: '2.5',
        }),
      ).rejects.toBeInstanceOf(HyperCardApiError);
    });

    it('passes an explicit type and status through', async () => {
      const result = await service.mockTxConsume({
        cardId: '00003454323400000028888',
        description: 'refund mock',
        fee: '0.50',
        transactionDate: '1595497477',
        txAmount: '10.00',
        txAmountUsd: '10.00',
        type: 8,
        status: 2,
      });

      expect(httpClient.postForAck).toHaveBeenCalledWith(
        'mock transaction consume',
        '/openapi/card/mock/tx/consume',
        expect.objectContaining({ type: 8, status: 2 }),
      );
      expect(result).toEqual({
        cardId: '00003454323400000028888',
        type: 8,
        status: 2,
      });
    });
  });

  describe('mock3dsTx', () => {
    it('defaults the timestamps to now and now plus fifteen minutes', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-12T00:00:00.000Z'));
      const nowSeconds = Math.floor(Date.parse('2026-08-12T00:00:00Z') / 1000);

      try {
        const result = await service.mock3dsTx({
          cardId: '00003454323400000028888',
          txnAmount: '2.5',
        });

        expect(httpClient.postForAck).toHaveBeenCalledWith(
          'mock 3DS transaction',
          '/openapi/card/mock/3ds',
          {
            card_id: '00003454323400000028888',
            txn_amount: '2.5',
            created_time: nowSeconds,
            expired_time: nowSeconds + 900,
          },
        );
        expect(result).toEqual({
          cardId: '00003454323400000028888',
          createdTime: nowSeconds,
          expiredTime: nowSeconds + 900,
        });
      } finally {
        jest.useRealTimers();
      }
    });

    it('passes explicit timestamps through unchanged', async () => {
      await service.mock3dsTx({
        cardId: '00003454323400000028888',
        txnAmount: '2.5',
        createdTime: 1595497477,
        expiredTime: 1595499277,
      });

      expect(httpClient.postForAck).toHaveBeenCalledWith(
        'mock 3DS transaction',
        '/openapi/card/mock/3ds',
        expect.objectContaining({
          created_time: 1595497477,
          expired_time: 1595499277,
        }),
      );
    });
  });

  describe('mockBindingData', () => {
    // Their "Mock Binding Data" documented success payload, verbatim.
    it('maps their response rows to the caller shape', async () => {
      httpClient.post.mockResolvedValueOnce([
        {
          card_number: '60000050000401001',
          secret: '888888',
          card_type_id: '6000005',
        },
      ]);

      const result = await service.mockBindingData('6000005');

      expect(httpClient.post).toHaveBeenCalledWith(
        'mock binding data',
        '/openapi/card/mock/binding',
        { card_type_id: '6000005' },
      );
      expect(result).toEqual({
        cards: [
          {
            cardNumber: '60000050000401001',
            secret: '888888',
            cardTypeId: '6000005',
          },
        ],
      });
    });

    // A sandbox PAN is still a PAN, and the secret is a credential. Neither may
    // reach a log line, however useful it would be while debugging.
    it('never writes the card number or the secret to the log', async () => {
      const logSpy = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);

      try {
        httpClient.post.mockResolvedValueOnce([
          {
            card_number: '60000050000401001',
            secret: '888888',
            card_type_id: '6000005',
          },
        ]);

        await service.mockBindingData('6000005');

        const logged = JSON.stringify(logSpy.mock.calls);
        expect(logged).not.toContain('60000050000401001');
        expect(logged).not.toContain('888888');
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe('mockAddBalance', () => {
    // Their "Mock Add Balance" documented success payload, verbatim.
    it('reports a credit when their response carries balances', async () => {
      httpClient.postForOptionalData.mockResolvedValueOnce([
        { coin: 'usdt', balance: '100000.00000000' },
      ]);

      const result = await service.mockAddBalance();

      expect(httpClient.postForOptionalData).toHaveBeenCalledWith(
        'mock add balance',
        '/openapi/card/mock/add/balance',
        {},
      );
      expect(result).toEqual({
        credited: true,
        balances: [{ coin: 'usdt', balance: '100000.00000000' }],
      });
    });

    // Their page: an empty payload means the credit has not landed, call again.
    // That is a documented outcome, not a failure.
    it('reports no credit when their response carries no data', async () => {
      httpClient.postForOptionalData.mockResolvedValueOnce(null);

      await expect(service.mockAddBalance()).resolves.toEqual({
        credited: false,
        balances: [],
      });
    });

    it('reports no credit when their response carries an empty array', async () => {
      httpClient.postForOptionalData.mockResolvedValueOnce([]);

      await expect(service.mockAddBalance()).resolves.toEqual({
        credited: false,
        balances: [],
      });
    });
  });

  describe('mockTxResend', () => {
    // Their "Mock tx resend" example request, verbatim.
    it('sends their documented payload', async () => {
      const result = await service.mockTxResend(
        '00003454323400000028888',
        '2023101610280651702869308',
      );

      expect(httpClient.postForAck).toHaveBeenCalledWith(
        'mock transaction resend',
        '/openapi/card/mock/tx/resend',
        {
          card_id: '00003454323400000028888',
          txid: '2023101610280651702869308',
        },
      );
      expect(result).toEqual({
        cardId: '00003454323400000028888',
        txid: '2023101610280651702869308',
      });
    });
  });
});
