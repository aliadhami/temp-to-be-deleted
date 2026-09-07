import { ApiProperty } from '@nestjs/swagger';
import { CardLifecycleOperation } from '../../domain/card-lifecycle-operation.enum';
import { CardOperationStatus } from '../../domain/card-operation-status.enum';
import { CardStatus } from '../../domain/card-status.enum';

/**
 * What a block or unblock request answers with.
 *
 * **It is not `CardResponseDto`**: this reports what the request just did, not
 * the whole card. A caller wanting the rest re-reads the card.
 */
export class CardStatusUpdateResponseDto {
  @ApiProperty({ format: 'uuid' })
  publicId!: string;

  @ApiProperty({
    enum: CardLifecycleOperation,
    example: CardLifecycleOperation.BLOCK,
    description: 'Which operation was requested',
  })
  operation!: CardLifecycleOperation;

  /**
   * The same vocabulary `lastOperation.status` publishes on the card reads, so
   * the answer to a request and the answer to a later read of the same
   * operation are one word rather than two.
   */
  @ApiProperty({
    enum: [CardOperationStatus.SUBMITTED, CardOperationStatus.APPLIED],
    description:
      'SUBMITTED means the issuer took the request on and has not carried it out — the card below is unchanged, and can still be spent on, until it does; watch lastOperation on the card. APPLIED means the card moved during this call. A refusal is not reported here: it is a 409.',
  })
  operationStatus!: CardOperationStatus;

  /**
   * **Frequently unchanged by the very request that returns it**, which is
   * what `operationStatus` above is for.
   */
  @ApiProperty({
    enum: CardStatus,
    description:
      'Where the card is now. On a SUBMITTED operation this is the status it had before the request',
  })
  cardStatus!: CardStatus;

  @ApiProperty({
    type: Boolean,
    required: false,
    description:
      'Whether the card’s status actually moved — false when it was already there. Absent on a SUBMITTED operation, where nothing has moved yet.',
  })
  updated?: boolean;
}
