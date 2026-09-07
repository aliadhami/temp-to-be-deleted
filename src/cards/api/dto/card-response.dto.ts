import { ApiProperty } from '@nestjs/swagger';
import { CardActivationStatus } from '../../domain/card-activation-status.enum';
import { CardApplicationStatus } from '../../domain/card-application-status.enum';
import { CardLifecycleOperation } from '../../domain/card-lifecycle-operation.enum';
import { CardOperationStatus } from '../../domain/card-operation-status.enum';
import { CardProviderKey } from '../../domain/card-provider-key.enum';
import { CardStatus } from '../../domain/card-status.enum';
import { CardType } from '../../domain/card-type.enum';

/** The figures a reconcile pass last read back from the issuer. */
export class CardBalanceResponseDto {
  @ApiProperty({
    example: '125.40',
    description: 'Decimal string in the currency below, never a number',
  })
  available!: string;

  /**
   * The three below are nullable because their columns are, not because an
   * issuer publishes a balance without them — a reconcile pass writes all
   * four or none. Handle the null; do not read it as a partial balance.
   */
  @ApiProperty({ type: String, nullable: true, example: '130.00' })
  ledger!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'USD',
    description: 'Need not be the card’s own currency',
  })
  currency!: string | null;

  /**
   * When these figures were last seen to *change*, not when the issuer was
   * last asked. There is no field that answers how stale the number is.
   */
  @ApiProperty({ type: Date, nullable: true })
  observedAt!: Date | null;
}

/**
 * How the attempt to open this card is going. Until an issuer that reviews
 * applications names a card, `status`, `maskedPan` and `activationStatus` read
 * exactly as they do for an opening that failed — for minutes.
 */
export class CardIssuanceResponseDto {
  @ApiProperty({
    enum: CardApplicationStatus,
    description:
      'SUBMITTED while the issuer is deciding — the healthy pending state, not a fault. SUBMISSION_FAILED means the request never reached them and no card is coming. APPROVED means they opened one.',
  })
  status!: CardApplicationStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why the attempt failed or was refused, in the issuer’s own vocabulary. Null while it is still in flight or once it succeeded.',
  })
  reasonCode!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Human-readable detail for the code above, where there is any',
  })
  reason!: string | null;

  @ApiProperty({
    type: Date,
    nullable: true,
    description:
      'When the issuer was last asked what became of this application — not when anything about it last changed. Null until the first time it is asked.',
  })
  lastCheckedAt!: Date | null;
}

/**
 * What was last *asked* of this card — not what it can do. Between an issuer
 * accepting a block and carrying it out, `status` on the card is unchanged and
 * this is the only thing that moves.
 *
 * **The most recent operation, not only one in flight.** A failed operation
 * leaves the card's own status alone and an issuer may give no reason at all,
 * so the message here is the only place a partner learns it failed.
 */
export class CardOperationResponseDto {
  @ApiProperty({
    enum: CardLifecycleOperation,
    description: 'What was asked for',
  })
  operation!: CardLifecycleOperation;

  @ApiProperty({
    enum: CardOperationStatus,
    description:
      'SUBMITTED while the issuer works it — the healthy pending state, not a fault. APPLIED means the card moved. FAILED means the issuer took the request on and did not carry it out, and REJECTED that it refused the request outright; on both the card is where it was. SUBMISSION_FAILED means the issuer never acknowledged the request, so nothing was changed. DRAFT means the request was recorded and its outcome is unknown — it needs an operator, and no further operation on this card will be accepted until it is resolved.',
  })
  status!: CardOperationStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why it did not succeed. The issuer’s own code where they gave one — read it against providerKey — and otherwise ours for a request they never acknowledged. Null while the operation is still in flight and once it has been applied.',
  })
  reasonCode!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Human-readable detail for the code above, where there is any',
  })
  reason!: string | null;

  @ApiProperty({ description: 'When this operation was requested' })
  requestedAt!: Date;

  @ApiProperty({
    type: Date,
    nullable: true,
    description:
      'When the issuer was last asked what became of it — not when anything about it last changed. Null until the first time it is asked, and always null for an issuer that carries operations out during the call.',
  })
  lastCheckedAt!: Date | null;
}

/**
 * The partner-facing shape of one card. It carries neither the issuer's own
 * card identifier nor its raw response, and it does carry which issuer holds
 * the card, because a partner using more than one chose that at onboarding and
 * needs it to know what the card will accept.
 *
 * **`activationReasonCode` is the one field that is issuer vocabulary, and
 * deliberately so** — see the note on it.
 */
export class CardResponseDto {
  @ApiProperty({ format: 'uuid' })
  publicId!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'The cardholder this card was issued to — the same id GET /cards/cardholders/:publicId answers to, for every issuer',
  })
  cardholderPublicId!: string;

  @ApiProperty({
    enum: CardProviderKey,
    description:
      'Which issuer holds this card — the key its cardholder was onboarded with, and the one its product catalogue is listed under',
  })
  providerKey!: CardProviderKey;

  @ApiProperty({ enum: CardType })
  cardType!: CardType;

  @ApiProperty({ enum: CardStatus })
  status!: CardStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '**** **** **** 1234',
    description: 'Null until the issuer has published one',
  })
  maskedPan!: string | null;

  /**
   * Whether an activation attempt is outstanding. **`status` cannot answer
   * this** — a card whose activation the issuer has accepted but not settled
   * is still `NOT_ACTIVATED`, so a caller reading the status alone would offer
   * to activate a card that is already being reviewed.
   */
  @ApiProperty({
    enum: CardActivationStatus,
    nullable: true,
    description:
      'PENDING while the issuer is settling an activation, FAILED when it refused one and a corrected attempt is allowed. Null when nothing is outstanding — no attempt was made, or the card is active.',
  })
  activationStatus!: CardActivationStatus | null;

  /**
   * **The issuer's own code, unmapped, and the only issuer vocabulary this
   * response carries.** There is no canonical cross-issuer list of reasons a
   * photograph can be refused, and inventing one would either collapse
   * distinctions a partner needs — an unclear document is a different retake
   * from a missing one — or invite a mapping that guesses. So it is published
   * raw and paired with `providerKey`, which is on this same response for
   * exactly this kind of reading. A partner that would rather not branch on
   * the issuer has `activationReason` beside it, which needs no lookup.
   */
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'E0003',
    description:
      'The issuer’s own code for a refused activation, in that issuer’s vocabulary — read it against providerKey. Set only alongside a FAILED activation status.',
  })
  activationReasonCode!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The issuer’s own words for a refused activation, where it gave any',
  })
  activationReason!: string | null;

  @ApiProperty({ example: 'USD', description: 'The card’s own currency' })
  currency!: string;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({
    type: CardBalanceResponseDto,
    nullable: true,
    description: 'Null until this card’s balance has been read at least once',
  })
  balance!: CardBalanceResponseDto | null;

  @ApiProperty({
    type: CardIssuanceResponseDto,
    nullable: true,
    description:
      'How the attempt to open this card is going. Null only for a card opened by something other than the issuance path.',
  })
  issuance!: CardIssuanceResponseDto | null;

  /**
   * **Not the catalogue's `supportedOperations`.** That field reports what the
   * issuer offers, routed or not; this one is bounded by the routes that
   * exist, then narrowed to the card's own product.
   */
  @ApiProperty({
    enum: CardLifecycleOperation,
    isArray: true,
    example: [CardLifecycleOperation.BLOCK, CardLifecycleOperation.UNBLOCK],
    description:
      'Which lifecycle operations this card accepts right now, so a page showing one card knows which controls to offer without reading the product catalogue. Empty means it accepts none of them — a real answer, not a missing one. Every member here has an endpoint on this API.',
  })
  availableOperations!: readonly CardLifecycleOperation[];

  /**
   * **Not `availableOperations`.** That field is what this card *can* do; this
   * one is what was last *asked* of it.
   */
  @ApiProperty({
    type: CardOperationResponseDto,
    nullable: true,
    description:
      'The most recent lifecycle operation requested against this card, or null if none ever was',
  })
  lastOperation!: CardOperationResponseDto | null;
}

export class CardListResponseDto {
  @ApiProperty({ type: [CardResponseDto] })
  items!: CardResponseDto[];

  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
}
