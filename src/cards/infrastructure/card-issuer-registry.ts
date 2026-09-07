import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CardCapability } from '../domain/card-capability.enum';
import { supportsCapability } from '../domain/card-issuer-guards';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardIssuerPort } from '../domain/card-issuer.port';

@Injectable()
export class CardIssuerRegistry implements OnModuleInit {
  private readonly adaptersByKey = new Map<CardProviderKey, CardIssuerPort>();
  private enabledKeys: readonly CardProviderKey[] = [];

  constructor(
    private readonly configService: ConfigService,
    private readonly adapters: CardIssuerPort[],
  ) {}

  onModuleInit(): void {
    const configuredKeys = this.configService.getOrThrow<string[]>(
      'PAYMENTS_ENABLED_CARD_PROVIDERS',
    ) as CardProviderKey[];

    for (const adapter of this.adapters) {
      this.adaptersByKey.set(adapter.key, adapter);
    }

    const missing = configuredKeys.filter(
      (key) => !this.adaptersByKey.has(key),
    );
    if (missing.length > 0) {
      throw new Error(
        `PAYMENTS_ENABLED_CARD_PROVIDERS references unknown adapter(s): ${missing.join(', ')}`,
      );
    }

    this.enabledKeys = configuredKeys;
  }

  /** Every enabled provider whose adapter declares this capability. */
  keysWithCapability(capability: CardCapability): CardProviderKey[] {
    return this.enabledKeys.filter((key) => {
      const adapter = this.adaptersByKey.get(key);
      return adapter !== undefined && supportsCapability(adapter, capability);
    });
  }

  /**
   * What one provider declares. **A provider that is not enabled answers with
   * an empty set rather than throwing**, unlike `resolve` — a read over rows
   * written earlier must not fail because a deployment switched a provider off.
   *
   * The empty answer is a fresh set per call, never a shared one: `ReadonlySet`
   * is erased at runtime, and a caller that casts and mutates a shared sentinel
   * would widen it for every later lookup in the process.
   */
  capabilitiesOf(key: CardProviderKey): ReadonlySet<CardCapability> {
    if (!this.enabledKeys.includes(key)) return new Set<CardCapability>();
    return this.adaptersByKey.get(key)?.capabilities ?? new Set();
  }

  resolve(key: CardProviderKey): CardIssuerPort {
    if (!this.enabledKeys.includes(key)) {
      // A 4xx, not a bare Error: `key` reaches here straight from a request
      // body validated with @IsEnum(CardProviderKey), so every enum member is
      // caller-supplied input. A member that exists but is not enabled is a bad
      // request, not a server fault, and must not surface as a 500.
      throw new BadRequestException(`Card provider "${key}" is not enabled`);
    }
    const adapter = this.adaptersByKey.get(key);
    // Deliberately still a bare Error: an enabled key with no adapter is a
    // missed wiring step in cards.module.ts, which is our bug and should be a
    // 500 rather than blamed on the caller.
    if (!adapter)
      throw new Error(`No adapter registered for card provider "${key}"`);
    return adapter;
  }
}
