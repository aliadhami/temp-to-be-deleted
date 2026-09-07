import { ApiProperty } from '@nestjs/swagger';
import { CardActivationStatus } from '../../domain/card-activation-status.enum';
import { CardStatus } from '../../domain/card-status.enum';

/**
 * What the activation route answers with.
 *
 * **It is not `CardResponseDto`**, and the difference matters: this reports
 * what the request just did, not the whole card. A caller wanting the rest
 * re-reads the card.
 */
export class CardActivationResponseDto {
  @ApiProperty({ format: 'uuid' })
  publicId!: string;

  /**
   * **Frequently unchanged by the very request that returns it.** An issuer
   * that acknowledges an activation and settles it afterwards leaves the card
   * not activated, so this alone cannot say whether the request landed — read
   * the field below for that.
   */
  @ApiProperty({ enum: CardStatus })
  status!: CardStatus;

  @ApiProperty({
    enum: CardActivationStatus,
    nullable: true,
    description:
      'PENDING when the issuer accepted the activation and has not settled it — the card is not usable yet and a further activation is refused until this resolves. Null when nothing is outstanding, which for this route means the issuer activated the card outright.',
  })
  activationStatus!: CardActivationStatus | null;
}
