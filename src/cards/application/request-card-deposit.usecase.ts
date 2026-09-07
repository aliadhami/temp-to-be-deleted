import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CardDepositResponseDto } from '../api/dto/card-deposit-response.dto';
import { isDuplicateEntryError } from '../../shared/persistence/duplicate-entry.util';
import { CardCapability } from '../domain/card-capability.enum';
import { CardDepositStatus } from '../domain/card-deposit-status.enum';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { CardStatus } from '../domain/card-status.enum';
import { CardDepositRequestResult } from '../domain/card-issuer.port';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import {
  CARD_DEPOSIT_MESSAGE_MAX_LENGTH,
  CARD_DEPOSIT_REASON_CODE_MAX_LENGTH,
  CardDepositEntity,
} from '../infrastructure/persistence/card-deposit.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { assertCardCapability } from './assert-card-capability';
import { toCardDepositResponse } from './card-deposit-projection';
import { assertDepositAmountWithinLimits } from './card-deposit-limits';
import { CardProductResolver } from './card-product-resolver';

export interface RequestCardDepositInput {
  partnerId: string;
  cardPublicId: string;
  requestId: string;
  amount: string;
  currency?: string | null;
  remark?: string | null;
}

/**
 * The value a partner actually supplied for an optional field, or `null` for
 * the several ways of supplying none — an absent key, an explicit `null` that
 * `@IsOptional()` lets through, and a field sent unfilled.
 */
const suppliedValue = (value: string | null | undefined): string | null =>
  value?.trim() || null;

/**
 * The `reason_code` written when the attempt failed on our side of the wire.
 * Distinct from an issuer code so a reader can tell "they said no" from "we
 * never got there".
 */
const LOCAL_FAILURE_CODE = 'SUBMISSION_ERROR';

/** Puts money on a card that already exists. */
@Injectable()
export class RequestCardDepositUseCase {
  private readonly logger = new Logger(RequestCardDepositUseCase.name);

  constructor(
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    @InjectRepository(CardDepositEntity)
    private readonly depositRepository: Repository<CardDepositEntity>,
    private readonly cardProductResolver: CardProductResolver,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
  ) {}

  async execute(
    input: RequestCardDepositInput,
  ): Promise<CardDepositResponseDto> {
    const card = await this.cardRepository.findOne({
      where: { publicId: input.cardPublicId, partnerId: input.partnerId },
    });
    // A card belonging to another partner is a 404 rather than a 403: the
    // partner scoping is in the query, so "not yours" and "does not exist" are
    // deliberately indistinguishable — the alternative confirms the existence
    // of rows the caller may not see.
    if (!card || !card.providerCardId) {
      throw new NotFoundException('Card not found');
    }
    const providerCardId = card.providerCardId;

    const adapter = this.cardIssuerRegistry.resolve(card.providerKey);
    // Above the write, so a refused call cannot leave an orphaned draft deposit
    // behind. Every issuer that cannot take a deposit request is refused here.
    assertCardCapability(
      adapter,
      CardCapability.DEPOSIT,
      card.providerKey,
      'depositing money onto a card',
    );

    if (card.status !== CardStatus.ACTIVE) {
      // Not merely tidiness. At least one issuer treats a deposit against a
      // card that is not yet open as the card's *opening* deposit instead — a
      // different operation, spent once, with different rules — and does so
      // silently.
      throw new ConflictException(
        `Card ${card.publicId} is ${card.status} — a deposit can only be made to an active card`,
      );
    }

    // The currency check first, because it costs nothing: it is settled from
    // the card row already in hand, and a request it refuses should not have
    // paid for the reads below.
    const currency = this.resolveCurrency(input, card);
    assertDepositAmountWithinLimits(
      input.amount,
      await this.cardProductResolver.resolveForCard(card.id, card.providerKey),
    );

    /**
     * Forwarded to the issuer and deliberately not stored: the remark is the
     * partner's note to the issuer and travels to their statement, where a
     * partner reads their own text rather than a copy that could differ.
     */
    const remark = suppliedValue(input.remark);

    const deposit = await this.writeDraft(input, card, currency);

    // **Only the call itself is inside the failure handler.** Everything after
    // it describes a request the issuer already holds, so a failure there is
    // not a failed deposit and must never be recorded as one — see
    // `markSubmitted`.
    const result = await this.callProvider(deposit, () =>
      adapter.requestCardDeposit(
        providerCardId,
        {
          // The row's own public id, which is what makes the reference unique
          // without a constraint of its own and what a settlement lookup will
          // be re-derived from. Whatever form the issuer wants it in is the
          // adapter's business.
          reference: deposit.publicId,
          amount: deposit.amount,
          currencyCode: deposit.currencyCode,
          // Conditional spread: under `exactOptionalPropertyTypes` an absent
          // optional cannot be set to undefined, and an absent remark is
          // ordinary rather than a loss.
          ...(remark && { remark }),
        },
        {},
      ),
    );

    // **The response is the deposit itself**, so a partner holds its identifier
    // and its state from the first call rather than having to read it back to
    // find out what they just created.
    return toCardDepositResponse(await this.markSubmitted(deposit, result));
  }

  /**
   * Records that the issuer accepted this deposit. Deliberately outside the
   * provider-failure handler.
   */
  private async markSubmitted(
    deposit: CardDepositEntity,
    result: CardDepositRequestResult,
  ): Promise<CardDepositEntity> {
    deposit.status = CardDepositStatus.SUBMITTED;
    deposit.providerDepositId = result.providerDepositId ?? null;
    deposit.responsePayload = result.rawPayload;

    try {
      return await this.depositRepository.save(deposit);
    } catch (error) {
      this.logger.error(
        `Card deposit ${deposit.publicId} was accepted by ${deposit.providerKey}` +
          ` (their id ${deposit.providerDepositId ?? 'not reported'}, reference ${deposit.providerReference})` +
          ` and could not be recorded as submitted — the money has been requested and the row is still ${CardDepositStatus.DRAFT}: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
      throw error;
    }
  }

  /**
   * Settles the currency: the card's, always, with a supplied value checked
   * against it rather than ignored.
   */
  private resolveCurrency(
    input: RequestCardDepositInput,
    card: CardEntity,
  ): string {
    const supplied = suppliedValue(input.currency);
    // Optional on the entity because the column carries a default, not because
    // a card can be without one — it is NOT NULL. Refused rather than asserted
    // away, so a row that somehow has none cannot denominate a deposit in
    // nothing at all.
    const cardCurrency = card.currency;
    if (!cardCurrency) {
      throw new ConflictException(
        `Card ${card.publicId} has no currency recorded — a deposit cannot be denominated`,
      );
    }

    if (supplied !== null && supplied !== cardCurrency) {
      throw new BadRequestException(
        `Card ${card.publicId} is denominated in ${cardCurrency}, not ${supplied}`,
      );
    }

    return cardCurrency;
  }

  /**
   * Writes the draft row, answering a replayed `requestId` with the deposit it
   * collides with.
   */
  private async writeDraft(
    input: RequestCardDepositInput,
    card: CardEntity,
    currency: string,
  ): Promise<CardDepositEntity> {
    const publicId = randomUUID();

    try {
      return await this.depositRepository.save(
        this.depositRepository.create({
          publicId,
          cardId: card.id,
          // Read from the card row, never from a caller.
          providerKey: card.providerKey,
          currencyCode: currency,
          requestId: input.requestId,
          providerReference: publicId,
          amount: input.amount,
          // Written before the issuer is called, so a crash mid-flight leaves a
          // record of the attempt rather than losing it.
          status: CardDepositStatus.DRAFT,
        }),
      );
    } catch (error) {
      if (isDuplicateEntryError(error, 'uq_card_deposit_provider_request')) {
        // Caught from the constraint rather than from a prior read: a check-
        // then-insert has a window under concurrency exactly where a partner's
        // retry lands.
        const existing = await this.depositRepository.findOne({
          where: {
            providerKey: card.providerKey,
            requestId: input.requestId,
          },
        });

        // Named only when it is the caller's own row.
        const owned =
          existing !== null &&
          (await this.cardRepository.findOne({
            where: { id: existing.cardId, partnerId: input.partnerId },
            select: { id: true },
          })) !== null;

        throw new ConflictException(
          `A deposit with requestId "${input.requestId}" already exists for this card provider` +
            (owned && existing
              ? ` (publicId: ${existing.publicId}, status: ${existing.status})`
              : ''),
        );
      }

      throw error;
    }
  }

  /**
   * Runs the provider call and, if it fails, leaves the row saying how — then
   * answers the partner with something they can act on. Which failure state
   * depends on whether the issuer answered.
   */
  private async callProvider<T>(
    deposit: CardDepositEntity,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      await this.recordFailure(deposit, error);

      if (error instanceof CardProviderConflictError) {
        // A composed sentence, never `error.message`. That message is built
        // around the issuer's own wire text and carries their HTTP status,
        // their code and our internal operation name — remote content of
        // unknown shape, which is not ours to republish.
        throw new ConflictException(
          'The card provider refused this deposit in its current state — the funding account may be short, or this card may not accept deposits',
          { cause: error },
        );
      }

      throw error;
    }
  }

  private async recordFailure(
    deposit: CardDepositEntity,
    error: unknown,
  ): Promise<void> {
    const refusedByIssuer = error instanceof CardProviderConflictError;
    const detail =
      error instanceof Error ? error.message : 'Unknown provider failure';

    this.logger.warn(
      refusedByIssuer
        ? `Card deposit ${deposit.publicId} was refused by ${deposit.providerKey}: ${detail}`
        : `Card deposit ${deposit.publicId} failed to reach ${deposit.providerKey}: ${detail}`,
    );

    // Captured before the mutation below, because the log in the catch names
    // the state the row is actually left in — which is the state it had when
    // the write failed, never the one the write was trying to set.
    const unwrittenStatus = deposit.status;

    try {
      deposit.status = refusedByIssuer
        ? CardDepositStatus.REJECTED
        : CardDepositStatus.SUBMISSION_FAILED;
      deposit.reasonCode = (
        refusedByIssuer ? error.providerCode : LOCAL_FAILURE_CODE
      ).slice(0, CARD_DEPOSIT_REASON_CODE_MAX_LENGTH);
      // Composed here, not copied from the provider's message.
      deposit.message = (
        refusedByIssuer
          ? 'The card provider refused this deposit'
          : 'This deposit did not reach the card provider'
      ).slice(0, CARD_DEPOSIT_MESSAGE_MAX_LENGTH);
      await this.depositRepository.save(deposit);
    } catch (bookkeepingError) {
      // Its own guard, because these writes run in exactly the circumstances
      // that break writes: a provider call that failed because the database
      // went away takes this bookkeeping with it, and without the guard the
      // repository's error would propagate in place of the provider's — so the
      // caller would hear about the symptom and never the cause.
      this.logger.error(
        `Could not record the failed card deposit ${deposit.publicId}, leaving it in ${unwrittenStatus}: ${
          bookkeepingError instanceof Error
            ? bookkeepingError.message
            : String(bookkeepingError)
        }`,
      );
    }
  }
}
