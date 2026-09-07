import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
} from 'class-validator';
import { ApiKeyScope } from '../../domain/api-key-scope.enum';

export class CreatePartnerApiKeyDto {
  @ApiProperty({ required: false, example: 'Production integration key' })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiProperty({
    enum: ApiKeyScope,
    isArray: true,
    example: [ApiKeyScope.PAYMENTS],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(ApiKeyScope, { each: true })
  scopes!: ApiKeyScope[];
}
