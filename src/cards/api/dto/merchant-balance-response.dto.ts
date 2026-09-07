import { ApiProperty } from '@nestjs/swagger';
import { CardProviderKey } from '../../domain/card-provider-key.enum';

/**
 * One asset's balance on our own account with an issuer. Read live and stored
 * nowhere, so this projects what they answered rather than a row of ours.
 */
export class MerchantBalanceEntryResponseDto {
  @ApiProperty({
    example: 'USDT',
    description:
      'The asset the balance is held in, upper-cased. A coin ticker, not necessarily an ISO 4217 currency — it is not always three characters.',
  })
  currencyCode!: string;

  @ApiProperty({
    example: '100.00',
    description:
      'Spendable now. A decimal string to the precision the issuer published, never a number.',
  })
  available!: string;

  @ApiProperty({
    example: '100.888888',
    description:
      'Everything held, including whatever is not yet available. Decimal string, as above.',
  })
  ledger!: string;
}

/** What one issuer says our account with it holds. */
export class MerchantBalanceResponseDto {
  @ApiProperty({ enum: CardProviderKey })
  providerKey!: CardProviderKey;

  @ApiProperty({
    type: [MerchantBalanceEntryResponseDto],
    description:
      'One entry per asset the issuer holds for us. Empty means it holds none — not that the read failed.',
  })
  entries!: MerchantBalanceEntryResponseDto[];

  @ApiProperty({
    example: '2026-02-03T04:05:06.789Z',
    description:
      'When the question was asked. Issuers publish no timestamp on a balance, so this is the moment of the call rather than of the figures.',
  })
  observedAt!: string;
}
