import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class SimulateCryptoDepositDto {
  @ApiProperty({ example: '0xbc19f66db5dc216f74fdd411527e23c652c99d4c' })
  @IsString()
  @IsNotEmpty()
  address!: string;

  @ApiProperty({ example: 'USDT' })
  @IsString()
  @IsNotEmpty()
  tokenId!: string;

  @ApiProperty({
    example: '100.00',
    description: 'Positive decimal string with at most 2 places',
  })
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'amount must be a positive decimal string with at most 2 places',
  })
  amount!: string;
}
