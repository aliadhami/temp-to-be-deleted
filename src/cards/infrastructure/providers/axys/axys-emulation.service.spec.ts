import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AxysEmulationService } from './axys-emulation.service';
import { AxysHttpClient } from './axys-http-client.service';

describe('AxysEmulationService', () => {
  let service: AxysEmulationService;
  let httpClient: { request: jest.Mock };
  let configService: { getOrThrow: jest.Mock };

  beforeEach(async () => {
    httpClient = { request: jest.fn() };
    configService = { getOrThrow: jest.fn(() => 'uat') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AxysEmulationService,
        { provide: AxysHttpClient, useValue: httpClient },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(AxysEmulationService);
    jest.clearAllMocks();
    configService.getOrThrow.mockReturnValue('uat');
  });

  describe('simulateSpend', () => {
    it('throws ForbiddenException in production without calling Axys', async () => {
      configService.getOrThrow.mockReturnValue('production');
      await expect(
        service.simulateSpend('axys-card-id', '10.00', 'idem-key-1'),
      ).rejects.toThrow(ForbiddenException);
      expect(httpClient.request).not.toHaveBeenCalled();
    });

    it('calls the emulation endpoint with card_id and amount, and the idempotency key', async () => {
      httpClient.request.mockResolvedValueOnce({
        status: 200,
        body: {
          success: true,
          data: { status: 'success', message: 'Spend simulated' },
          requestId: 'req-1',
          timestamp: '2026-07-08T12:00:00.000Z',
        },
      });

      await service.simulateSpend('axys-card-id', '10.00', 'idem-key-1');

      expect(httpClient.request).toHaveBeenCalledWith(
        'POST',
        '/emulation/simulate-spend',
        { card_id: 'axys-card-id', amount: '10.00' },
        'idem-key-1',
      );
    });

    it('throws when Axys returns an error envelope', async () => {
      httpClient.request.mockResolvedValueOnce({
        status: 409,
        body: {
          success: false,
          error: { code: 'INVALID_STATE_TRANSITION', message: 'not active' },
          requestId: 'req-2',
          timestamp: '2026-07-08T12:00:00.000Z',
        },
      });

      await expect(
        service.simulateSpend('axys-card-id', '10.00', 'idem-key-1'),
      ).rejects.toThrow(/emulation spend simulation failed/);
    });
  });

  describe('prepareSpendOtp', () => {
    it('throws ForbiddenException in production without calling Axys', async () => {
      configService.getOrThrow.mockReturnValue('production');
      await expect(
        service.prepareSpendOtp('axys-card-id', 'idem-key-2'),
      ).rejects.toThrow(ForbiddenException);
      expect(httpClient.request).not.toHaveBeenCalled();
    });

    it('returns the generated pin on success', async () => {
      httpClient.request.mockResolvedValueOnce({
        status: 200,
        body: {
          success: true,
          data: { status: 'success', pin: '123456' },
          requestId: 'req-3',
          timestamp: '2026-07-08T12:00:00.000Z',
        },
      });

      const result = await service.prepareSpendOtp(
        'axys-card-id',
        'idem-key-2',
      );

      expect(result).toEqual({ pin: '123456' });
      expect(httpClient.request).toHaveBeenCalledWith(
        'POST',
        '/emulation/prepare-spend-otp',
        { card_id: 'axys-card-id' },
        'idem-key-2',
      );
    });
  });
});
