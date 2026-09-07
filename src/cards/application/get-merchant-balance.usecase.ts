import { Injectable } from '@nestjs/common';
import { CardCapability } from '../domain/card-capability.enum';
import { MerchantBalanceResult } from '../domain/card-issuer.port';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { assertCardCapability } from './assert-card-capability';

export interface GetMerchantBalanceResult extends MerchantBalanceResult {
  providerKey: CardProviderKey;
}

/** Reads our own float with a card issuer — neither a card's balance nor a partner's. */
@Injectable()
export class GetMerchantBalanceUseCase {
  constructor(private readonly cardIssuerRegistry: CardIssuerRegistry) {}

  async execute(
    providerKey: CardProviderKey,
  ): Promise<GetMerchantBalanceResult> {
    const issuer = this.cardIssuerRegistry.resolve(providerKey);
    assertCardCapability(
      issuer,
      CardCapability.MERCHANT_BALANCE_READ,
      providerKey,
      'a merchant balance read',
    );

    const result = await issuer.getMerchantBalance({});

    return { providerKey, ...result };
  }
}
