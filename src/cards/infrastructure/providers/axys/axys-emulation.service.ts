import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxysHttpClient } from './axys-http-client.service';
import { unwrapAxysData } from './axys-response.util';
import { AxysEnvelope } from './axys.types';

interface AxysEmulationResultData {
  status: string;
  result: Record<string, unknown>;
}

interface AxysSimulateDepositData {
  status: string;
  message: string;
  tx_id: string;
}

interface AxysSimulateSpendData {
  status: string;
  message: string;
}

interface AxysPrepareSpendOtpData {
  status: string;
  pin: string;
}

@Injectable()
export class AxysEmulationService {
  constructor(
    private readonly httpClient: AxysHttpClient,
    private readonly configService: ConfigService,
  ) {}

  private assertNotProduction(): void {
    const env = this.configService.getOrThrow<string>('PAYMENTS_AXYS_ENV');
    if (env === 'production') {
      throw new ForbiddenException(
        'Staging emulation routes are not available in the production environment',
      );
    }
  }

  async validateKyc(
    providerCardholderId: string,
    result: 'pass' | 'fail',
    idempotencyKey: string,
  ): Promise<void> {
    this.assertNotProduction();
    console.log(
      `[AxysEmulationService] validateKyc: providerCardholderId=${providerCardholderId}, result=${result}, idempotencyKey=${idempotencyKey}`,
    );
    const response = await this.httpClient.request<
      AxysEnvelope<AxysEmulationResultData>
    >(
      'POST',
      '/emulation/kyc/validate',
      { account_id: providerCardholderId, result },
      idempotencyKey,
    );
    unwrapAxysData('emulation KYC validate', response.status, response.body);
  }

  async simulateCryptoDeposit(
    address: string,
    tokenId: string,
    amount: string,
    idempotencyKey: string,
  ): Promise<{ txId: string }> {
    this.assertNotProduction();
    console.log(
      `[AxysEmulationService] simulateCryptoDeposit: address=${address}, tokenId=${tokenId}, amount=${amount}, idempotencyKey=${idempotencyKey}`,
    );
    const response = await this.httpClient.request<
      AxysEnvelope<AxysSimulateDepositData>
    >(
      'POST',
      '/emulation/simulate-crypto-deposit',
      { address, token_id: tokenId, amount },
      idempotencyKey,
    );
    const data = unwrapAxysData(
      'emulation crypto deposit simulation',
      response.status,
      response.body,
    );
    return { txId: data.tx_id };
  }

  async simulateSpend(
    providerCardId: string,
    amount: string,
    idempotencyKey: string,
  ): Promise<void> {
    this.assertNotProduction();
    console.log(
      `[AxysEmulationService] simulateSpend: providerCardId=${providerCardId}, amount=${amount}, idempotencyKey=${idempotencyKey}`,
    );
    const response = await this.httpClient.request<
      AxysEnvelope<AxysSimulateSpendData>
    >(
      'POST',
      '/emulation/simulate-spend',
      { card_id: providerCardId, amount },
      idempotencyKey,
    );
    unwrapAxysData(
      'emulation spend simulation',
      response.status,
      response.body,
    );
  }

  async prepareSpendOtp(
    providerCardId: string,
    idempotencyKey: string,
  ): Promise<{ pin: string }> {
    this.assertNotProduction();
    console.log(
      `[AxysEmulationService] prepareSpendOtp: providerCardId=${providerCardId}, idempotencyKey=${idempotencyKey}`,
    );
    const response = await this.httpClient.request<
      AxysEnvelope<AxysPrepareSpendOtpData>
    >(
      'POST',
      '/emulation/prepare-spend-otp',
      { card_id: providerCardId },
      idempotencyKey,
    );
    const data = unwrapAxysData(
      'emulation spend OTP preparation',
      response.status,
      response.body,
    );
    return { pin: data.pin };
  }
}
