import { ApiProperty } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { CardProviderKey } from '../../domain/card-provider-key.enum';

export class ListCardProductsQueryDto {
  /** Required rather than defaulted or inferred. */
  @ApiProperty({
    enum: CardProviderKey,
    description: 'Which provider’s catalogue to list',
  })
  @IsEnum(CardProviderKey)
  providerKey!: CardProviderKey;

  /**
   * Withdrawn products are excluded by default because a partner reading this
   * list is choosing something to issue. They stay listable because a card
   * already issued against a withdrawn product still needs it to describe
   * itself.
   */
  @ApiProperty({
    required: false,
    default: false,
    description:
      'Include products the provider will no longer accept applications for',
  })
  @IsOptional()
  // Anything other than the two literal spellings is left untouched so
  // @IsBoolean() rejects it with a 400. `@Type(() => Boolean)` cannot be used
  // here: `Boolean('false')` is `true`, so it would silently invert the one
  // value a caller is most likely to send.
  @Transform(({ value }: TransformFnParams): unknown => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  })
  @IsBoolean()
  includeUnavailable?: boolean = false;
}
