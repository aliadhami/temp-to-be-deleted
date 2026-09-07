import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GatewayKey } from '../domain/gateway-key.enum';
import { PaymentGatewayPort } from '../domain/payment-gateway.port';

export const PAYMENT_GATEWAY_ADAPTERS = 'PAYMENT_GATEWAY_ADAPTERS';

@Injectable()
export class GatewayRegistry implements OnModuleInit {
  private readonly adaptersByKey = new Map<GatewayKey, PaymentGatewayPort>();
  private enabledKeys: readonly GatewayKey[] = [];

  constructor(
    private readonly configService: ConfigService,
    private readonly adapters: PaymentGatewayPort[],
  ) {}

  onModuleInit(): void {
    const configuredKeys = this.configService.getOrThrow<string[]>(
      'PAYMENTS_ENABLED_GATEWAYS',
    ) as GatewayKey[];

    for (const adapter of this.adapters) {
      this.adaptersByKey.set(adapter.key, adapter);
    }

    const missing = configuredKeys.filter(
      (key) => !this.adaptersByKey.has(key),
    );
    if (missing.length > 0) {
      throw new Error(
        `PAYMENTS_ENABLED_GATEWAYS references unknown gateway adapter(s): ${missing.join(', ')}`,
      );
    }

    // Fail fast if an enabled gateway is missing its required environment URL —
    // don't wait for the first real payment request to discover this.
    for (const key of configuredKeys) {
      const envValue = process.env[`PAYMENTS_${key}_ENV`];
      const uatUrl =
        process.env[`PAYMENTS_${key}_UAT_URL`] ||
        process.env[`PAYMENTS_${key}_SANDBOX_URL`];
      const prodUrl = process.env[`PAYMENTS_${key}_PROD_URL`];
      const requiredUrl = envValue === 'production' ? prodUrl : uatUrl;
      if (!requiredUrl) {
        throw new Error(
          `Gateway "${key}" is enabled but its ${envValue === 'production' ? 'production' : 'UAT/sandbox'} URL is not configured (check PAYMENTS_${key}_ENV and the corresponding _URL variable)`,
        );
      }
    }

    this.enabledKeys = configuredKeys;
  }

  resolve(key: GatewayKey): PaymentGatewayPort {
    if (!this.enabledKeys.includes(key)) {
      throw new Error(`Gateway "${key}" is not enabled`);
    }
    const adapter = this.adaptersByKey.get(key);
    if (!adapter) {
      throw new Error(`No adapter registered for gateway "${key}"`);
    }
    return adapter;
  }

  listEnabled(): readonly GatewayKey[] {
    return this.enabledKeys;
  }
}
