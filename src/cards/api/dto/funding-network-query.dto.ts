import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { FundingNetwork } from '../../domain/funding-network.enum';

/** The chain half of a funding quote. Optional: only the payable precision depends on it. */
export abstract class FundingNetworkQueryDto {
  @ApiProperty({
    required: false,
    enum: FundingNetwork,
    description:
      'The chain you intend to pay on. Omit it and the payable amount is rounded to the coarsest precision across every supported chain, which is payable on all of them.',
  })
  @IsOptional()
  @IsEnum(FundingNetwork)
  network?: FundingNetwork;
}
