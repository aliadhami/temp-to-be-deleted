import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class SimulateSpendDto {
  @ApiProperty({
    example: '10.00',
    description: 'Positive decimal string with at most 2 places',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'amount must be a positive decimal string with at most 2 places',
  })
  amount!: string;
}
