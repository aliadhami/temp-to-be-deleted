import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

export class UpdateCardPinDto {
  @ApiProperty({
    example: '0123',
    description: 'Current PIN, exactly 4 digits',
  })
  @Matches(/^\d{4}$/, { message: 'oldPin must be exactly 4 digits' })
  oldPin!: string;

  @ApiProperty({ example: '0456', description: 'New PIN, exactly 4 digits' })
  @Matches(/^\d{4}$/, { message: 'newPin must be exactly 4 digits' })
  newPin!: string;
}
