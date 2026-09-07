import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { isTransactionRestartError } from '../../shared/persistence/duplicate-entry.util';
import { CardApplicationStatus } from '../domain/card-application-status.enum';
import { CardCapability } from '../domain/card-capability.enum';
import { supportsCapability } from '../domain/card-issuer-guards';
import { CardIssuerPort } from '../domain/card-issuer.port';
import { NAME_ON_CARD_MAX_LENGTH } from '../domain/card-issuance-intent.model';
import { CardEventSource } from '../domain/card-event-source.enum';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { CardProviderIntentRejectedError } from '../domain/card-provider-intent-rejected.error';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardProviderUnsupportedApplicationModeError } from '../domain/card-provider-unsupported-application-mode.error';
import { CardStatus } from '../domain/card-status.enum';
import { CardType } from '../domain/card-type.enum';
import { CardholderStatus } from '../domain/cardholder-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import {
  CARD_APPLICATION_MESSAGE_MAX_LENGTH,
  CARD_APPLICATION_REASON_CODE_MAX_LENGTH,
  CardApplicationEntity,
} from '../infrastructure/persistence/card-application.entity';
import { CardEventEntity } from '../infrastructure/persistence/card-event.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';
import { CardholderEnrolmentResolver } from './cardholder-enrolment.resolver';
import {
  CARD_PRODUCT_REFERENCE_FIELD,
  CardProductResolver,
  ResolvedCardProduct,
} from './card-product-resolver';
import { compareDecimalStrings } from './decimal-amount.util';

export interface IssueCardInput {
  partnerId: string;
  cardholderPublicId: string;
  providerKey: CardProviderKey;
  cardType: CardType;
  nameOnCard?: string | null;
  currency?: string | null;
  cardProductPublicId?: string | null;
  initialDepositAmount?: string | null;
}

/**
 * What the request asked for, once settled against the issuer and the product.
 * The write takes these and never `input`'s own, so a derived value cannot be
 * bypassed by a later edit reaching for the request instead.
 */
interface ResolvedCardFields {
  nameOnCard: string;
  currency: string;
  initialDepositAmount: string | null;
}

/**
 * The value a partner actually supplied for an optional field, or `null` for
 * the several ways of supplying none.
 */
const suppliedValue = (value: string | null | undefined): string | null =>
  value?.trim() || null;

/**
 * The `reason_code` written when the attempt failed on our side of the wire.
 * Distinct from an issuer code so a reader can tell "they said no" from "we
 * never got there".
 */
const LOCAL_FAILURE_CODE = 'SUBMISSION_ERROR';

/** The original attempt plus four restarts. */
const MAX_WRITE_ATTEMPTS = 5;

/**
 * How long a restarted attempt waits, multiplied by the attempt number and
 * jittered, so racers rolled back together do not queue up in lockstep. Small
 * on purpose: this runs inline on a partner's request.
 */
const RESTART_BASE_DELAY_MS = 10;

@Injectable()
export class IssueCardUseCase {
  private readonly logger = new Logger(IssueCardUseCase.name);

  constructor(
    @InjectRepository(CardholderEntity)
    private readonly cardholderRepository: Repository<CardholderEntity>,
    @InjectRepository(CardEntity)
    private readonly cardRepository: Repository<CardEntity>,
    @InjectRepository(CardEventEntity)
    private readonly eventRepository: Repository<CardEventEntity>,
    @InjectRepository(CardApplicationEntity)
    private readonly applicationRepository: Repository<CardApplicationEntity>,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
    private readonly enrolmentResolver: CardholderEnrolmentResolver,
    private readonly cardProductResolver: CardProductResolver,
    private readonly dataSource: DataSource,
  ) {}

  async execute(input: IssueCardInput) {
    const cardholder = await this.cardholderRepository.findOne({
      where: { publicId: input.cardholderPublicId, partnerId: input.partnerId },
    });
    if (!cardholder) throw new NotFoundException('Cardholder not found');

    // The person's standing with *this* issuer. An approval one issuer gave
    // says nothing about another, so the enrolment is what gates issuance.
    const enrolment = await this.enrolmentResolver.require(
      cardholder.id,
      input.providerKey,
    );
    if (
      enrolment.status !== CardholderStatus.APPROVED ||
      !enrolment.providerCardholderId
    ) {
      throw new ConflictException(
        `Cardholder is not approved by card provider "${input.providerKey}" (${enrolment.status}) — cannot issue a card yet`,
      );
    }
    // Captured once, rather than re-read through the entity below: the guard
    // above narrows a property access only until the next `await`.
    const providerCardholderId = enrolment.providerCardholderId;

    const adapter = this.cardIssuerRegistry.resolve(input.providerKey);
    // Checked before the card row is written, not after — persistence-first
    // would otherwise orphan a NOT_ACTIVATED card for a provider that cannot
    // issue this form factor. The capability is chosen by requested type, so
    // an adapter that issues virtual cards only is not credited with physical.
    const issuanceCapability =
      input.cardType === CardType.PHYSICAL
        ? CardCapability.ISSUE_PHYSICAL
        : CardCapability.ISSUE_VIRTUAL;
    if (!supportsCapability(adapter, issuanceCapability)) {
      throw new ForbiddenException(
        `Card provider "${input.providerKey}" does not support issuing ${input.cardType.toLowerCase()} cards`,
      );
    }

    // Every rejection this can raise is the resolver's, stated once there.
    // Null means the provider has no catalogue and none was supplied.
    const product = await this.cardProductResolver.resolve({
      providerKey: input.providerKey,
      cardProductPublicId: input.cardProductPublicId,
    });

    // Checked before the deposit is settled: a form factor that disagrees with
    // the product is a more fundamental fault than a missing amount, and
    // answering the deposit first would send a partner to fix a figure on a
    // request that was never going to open the card they asked for.
    this.assertCardTypeMatchesProduct(input, product);
    const currency = this.resolveCurrency(input, product);
    const nameOnCard = this.resolveNameOnCard(input, cardholder, adapter);
    const initialDepositAmount = this.resolveInitialDeposit(input, product);

    // Both rows in one transaction, because of the application table's
    // constraints.
    const { card, application } = await this.writeAttemptWithRetry(
      input,
      cardholder,
      product,
      { nameOnCard, currency, initialDepositAmount },
    );

    const idempotencyKey = `card-${card.publicId}`;
    const result = await this.callProvider(application, () =>
      adapter.issueCard(
        // The account handle an issuer that holds one opens the card against.
        // An issuer that models no person ignores it; the application is
        // addressed by the card's own public id either way.
        providerCardholderId,
        {
          publicId: card.publicId,
          cardholderPublicId: cardholder.publicId,
          providerKey: input.providerKey,
          cardType: input.cardType,
          nameOnCard,
          applicant: {
            firstName: cardholder.firstName,
            lastName: cardholder.lastName,
            email: cardholder.email,
            callingCode: cardholder.identityProvenance.callingCode,
            cellNumber: cardholder.identityProvenance.cellNumber,
            // Conditional spreads throughout: under
            // `exactOptionalPropertyTypes` an absent optional cannot be set to
            // undefined, and an absent IP is ordinary rather than a loss.
            ...(cardholder.userIp && { userIp: cardholder.userIp }),
          },
          ...(product && {
            cardProduct: {
              providerProductId: product.providerProductId,
              applicationMode: product.applicationMode,
            },
          }),
          ...(initialDepositAmount && { initialDepositAmount }),
        },
        {},
        idempotencyKey,
      ),
    );

    // Written before the card row, and the order is load-bearing. The moment
    // the call returns, the issuer holds an application, so that fact has to
    // reach the database before anything else can fail.
    await this.markApplication(application, CardApplicationStatus.SUBMITTED);

    // An asynchronous issuer returns neither the card id nor the card number
    // on the application call, so the row stays pending with the columns null.
    // Not a provider branch: whatever the adapter leaves out is simply absent.
    card.providerCardId = result.providerCardId || null;
    card.status = result.status;
    card.maskedPan = result.maskedPan || null;
    await this.cardRepository.save(card);

    if (!card.providerCardId) {
      // Logged, but not as a warning: for an asynchronous issuer this is the
      // ordinary outcome. One line still earns its place — without it an
      // adapter that silently drops the id is indistinguishable from an
      // acknowledgement, and the card is unusable either way.
      this.logger.log(
        `Card ${card.publicId} persisted without a provider card id (${input.providerKey}) — awaiting the provider's issuance result`,
      );
    }

    await this.eventRepository.save(
      this.eventRepository.create({
        cardId: card.id,
        fromStatus: CardStatus.NOT_ACTIVATED,
        toStatus: result.status,
        source: CardEventSource.SYSTEM,
      }),
    );

    return {
      publicId: card.publicId,
      status: card.status,
      maskedPan: card.maskedPan,
    };
  }

  /**
   * Settles what opening deposit, if any, this application commits. Refused
   * rather than defaulted when the product mandates one and none arrived —
   * filling in the product's minimum would spend a partner's money at a figure
   * they never named.
   */
  private resolveInitialDeposit(
    input: IssueCardInput,
    product: ResolvedCardProduct | null,
  ): string | null {
    const supplied = suppliedValue(input.initialDepositAmount);

    if (!product) return supplied;

    const minimum = product.depositMinInitial;

    if (supplied === null) {
      // Only a mandate makes an absent amount a fault. A product that states a
      // minimum without requiring a deposit is describing what an amount must
      // clear if one is sent, not demanding one.
      if (!product.requiresInitialDeposit) return null;

      throw new BadRequestException(
        `Card product "${product.publicId}" requires an opening deposit — initialDepositAmount is missing` +
          (minimum ? ` (minimum ${minimum} ${product.currencyCode})` : ''),
      );
    }

    // **Checked whenever an amount was supplied, mandate or not.** The two are
    // independent facts on the product, and an issuer that states a minimum
    // applies it to any amount it receives — so skipping this for an optional
    // deposit forwards a figure that parks the card at pending-payment.
    if (minimum !== null) {
      const comparison = compareDecimalStrings(supplied, minimum);
      if (comparison === null) {
        // One of the two is not a plain decimal, and the supplied half cannot
        // be — the DTO's pattern refused anything else — so this is the stored
        // minimum.
        this.logger.error(
          `Card product "${product.publicId}" has an unreadable minimum opening deposit "${minimum}" — refusing the application rather than applying with an unchecked amount`,
        );
        throw new BadRequestException(
          `Card product "${product.publicId}" has an opening-deposit minimum this service cannot read — contact support`,
        );
      }

      if (comparison < 0) {
        throw new BadRequestException(
          `Card product "${product.publicId}" requires an opening deposit of at least ${minimum} ${product.currencyCode} — initialDepositAmount is ${supplied}`,
        );
      }
    }

    return supplied;
  }

  /**
   * Refuses a request whose form factor disagrees with the product it names.
   */
  private assertCardTypeMatchesProduct(
    input: IssueCardInput,
    product: ResolvedCardProduct | null,
  ): void {
    if (!product) return;
    if (input.cardType === product.cardType) return;

    throw new BadRequestException(
      `Card product "${product.publicId}" issues ${product.cardType.toLowerCase()} cards, not ${input.cardType.toLowerCase()}`,
    );
  }

  /**
   * Settles the card's currency: the product's where there is one, the
   * request's where there is not.
   */
  private resolveCurrency(
    input: IssueCardInput,
    product: ResolvedCardProduct | null,
  ): string {
    const supplied = suppliedValue(input.currency);

    if (!product) {
      // No catalogue: the request is the only statement of the currency there
      // is, so it has to carry one. Defaulting would mean guessing what a card
      // is denominated in, which is not a guess worth making.
      if (supplied === null) {
        throw new BadRequestException(
          'currency is required for a provider that publishes no product catalogue',
        );
      }
      return supplied;
    }

    if (supplied !== null && supplied !== product.currencyCode) {
      throw new BadRequestException(
        `Card product "${product.publicId}" is denominated in ${product.currencyCode}, not ${supplied}`,
      );
    }

    return product.currencyCode;
  }

  /**
   * Settles the name printed on the card, which not every issuer lets a caller
   * choose. Required, forbidden, or derived — decided by the capability, never
   * by the provider key.
   */
  private resolveNameOnCard(
    input: IssueCardInput,
    cardholder: CardholderEntity,
    adapter: CardIssuerPort,
  ): string {
    const supplied = suppliedValue(input.nameOnCard);

    if (supportsCapability(adapter, CardCapability.CUSTOM_NAME_ON_CARD)) {
      if (supplied === null) {
        throw new BadRequestException(
          `Card provider "${input.providerKey}" prints the name you choose — nameOnCard is required`,
        );
      }
      return supplied;
    }

    if (supplied !== null) {
      throw new BadRequestException(
        `Card provider "${input.providerKey}" names the card after the cardholder and cannot print a chosen name — nameOnCard must not be supplied`,
      );
    }

    const derived = `${cardholder.firstName} ${cardholder.lastName}`.trim();

    if (derived.length === 0) {
      // The stored cardholder cannot name a card. Nothing on *this* request is
      // wrong, so it is the cardholder's state that is reported rather than a
      // field — and storing an empty string would put no information at all in
      // the one column meant to say what the card reads.
      throw new ConflictException(
        `Cardholder ${cardholder.publicId} has no name to print on a card, and this provider prints the cardholder's own name`,
      );
    }

    // Trimmed to the column rather than refused: nothing was supplied to
    // reject, and both halves were accepted when the cardholder was created.
    // `card.name_on_card` is half the width of the two name columns combined.
    return [...derived].slice(0, NAME_ON_CARD_MAX_LENGTH).join('');
  }

  /**
   * Writes the card and its application in one transaction, restarting on a
   * deadlock. The transaction issues no `SELECT` — it is two inserts, and the
   * row each reads back is its own.
   *
   * No duplicate branch: the reference is the public id of the card inserted
   * beside it, so `uq_card_application_provider_request` cannot trip without
   * two cards sharing a `public_id`.
   */
  private async writeAttemptWithRetry(
    input: IssueCardInput,
    cardholder: CardholderEntity,
    product: ResolvedCardProduct | null,
    resolved: ResolvedCardFields,
  ): Promise<{ card: CardEntity; application: CardApplicationEntity }> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.dataSource.transaction((manager) =>
          this.writeAttempt(manager, input, cardholder, product, resolved),
        );
      } catch (error) {
        if (isTransactionRestartError(error) && attempt < MAX_WRITE_ATTEMPTS) {
          this.logger.warn(
            `Card issuance for cardholder ${cardholder.publicId} was rolled back by the server — restarting the transaction`,
          );
          await this.pauseBeforeRestart(attempt);
          continue;
        }

        throw error;
      }
    }
  }

  /**
   * The two inserts, in the only order the schema allows: the card first,
   * because `card_application.card_id` is NOT NULL.
   */
  private async writeAttempt(
    manager: EntityManager,
    input: IssueCardInput,
    cardholder: CardholderEntity,
    product: ResolvedCardProduct | null,
    resolved: ResolvedCardFields,
  ): Promise<{ card: CardEntity; application: CardApplicationEntity }> {
    const cards = manager.getRepository(CardEntity);
    const applications = manager.getRepository(CardApplicationEntity);

    const card = await cards.save(
      cards.create({
        partnerId: input.partnerId,
        cardholderId: cardholder.id,
        providerKey: input.providerKey,
        cardType: input.cardType,
        // The settled values, not the request's: for an issuer that names the
        // card after the cardholder these are derived, and storing the raw
        // request would make the row describe a card that does not exist.
        nameOnCard: resolved.nameOnCard,
        currency: resolved.currency,
        status: CardStatus.NOT_ACTIVATED,
      }),
    );

    const application = await applications.save(
      applications.create({
        cardId: card.id,
        // Read from the card row, never from request input. Nothing in the
        // database keeps this copy in step with `card.provider_key`, and a row
        // where the two disagree would resolve the adapter from one issuer
        // while the card taking the result belongs to another.
        providerKey: card.providerKey,
        // The card's own public id, never the cardholder's: this reference
        // identifies the attempt, and one attempt is one card.
        requestId: card.publicId,
        cardProductId: product?.id ?? null,
        initialDepositAmount: resolved.initialDepositAmount,
        // Written before the issuer is called, so a crash mid-flight leaves a
        // record of the attempt rather than losing it.
        status: CardApplicationStatus.DRAFT,
      }),
    );

    return { card, application };
  }

  private pauseBeforeRestart(attempt: number): Promise<void> {
    const ceiling = RESTART_BASE_DELAY_MS * attempt;
    return new Promise((resolve) =>
      setTimeout(resolve, Math.random() * ceiling),
    );
  }

  /**
   * Runs the provider call and, if it fails, leaves the application row saying
   * so — then answers the partner with something they can act on. The
   * application row is what stops a failed attempt stranding the card.
   */
  private async callProvider<T>(
    application: CardApplicationEntity,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      await this.recordFailure(application, error);

      // A product this integration does not apply for. The error names the mode
      // and the modes that are served, and deliberately names no request field
      // — that is this layer's vocabulary, so this layer supplies it.
      if (error instanceof CardProviderUnsupportedApplicationModeError) {
        throw new BadRequestException(
          `${error.message} Supply a ${CARD_PRODUCT_REFERENCE_FIELD} whose product is applied for in one of those modes.`,
          { cause: error },
        );
      }

      // The issuer refused over the state of things — a duplicate application,
      // a card type at its issuance limit, or a product withdrawn since our
      // catalogue last synced.
      if (error instanceof CardProviderConflictError) {
        // A composed sentence, never `error.message`. That message is built
        // around the issuer's own wire text and carries their status, their
        // code and our internal operation name — remote content of unknown
        // shape, not ours to republish.
        throw new ConflictException(
          'The card provider refused this application in its current state — the product may no longer be on offer, or this cardholder may already have a card of this type',
          { cause: error },
        );
      }

      // The adapter refused a value before sending it, knowing the issuer's own
      // documented constraints. That is the partner's to fix, and the message
      // already names the field in our vocabulary.
      if (error instanceof CardProviderIntentRejectedError) {
        throw new BadRequestException(error.message, { cause: error });
      }

      throw error;
    }
  }

  /**
   * Moves the application to a terminal-for-now state, never displacing
   * anything else.
   */
  private async recordFailure(
    application: CardApplicationEntity,
    error: unknown,
  ): Promise<void> {
    const reason =
      error instanceof Error ? error.message : 'Unknown provider failure';

    // Which state depends on whether the issuer answered. A conflict is a
    // refusal the issuer composed, so the row is `REJECTED`, carrying their
    // own code.
    const refusedByIssuer = error instanceof CardProviderConflictError;

    this.logger.warn(
      refusedByIssuer
        ? `Card application ${application.requestId} was refused by ${application.providerKey}: ${reason}`
        : `Card application ${application.requestId} failed to reach ${application.providerKey}: ${reason}`,
    );

    try {
      await this.markApplication(
        application,
        refusedByIssuer
          ? CardApplicationStatus.REJECTED
          : CardApplicationStatus.SUBMISSION_FAILED,
        refusedByIssuer ? error.providerCode : LOCAL_FAILURE_CODE,
        reason,
      );
    } catch (bookkeepingError) {
      this.logger.error(
        `Could not record the failed card application ${application.requestId}, leaving it in ${application.status}: ${
          bookkeepingError instanceof Error
            ? bookkeepingError.message
            : String(bookkeepingError)
        }`,
      );
    }
  }

  /**
   * `response_payload` is deliberately left alone on both paths. Their
   * application answers an acknowledgement and nothing else, so the column
   * would hold a constant; a failure's code and message go to the two columns
   * above.
   */
  private async markApplication(
    application: CardApplicationEntity,
    status: CardApplicationStatus,
    reasonCode: string | null = null,
    message: string | null = null,
  ): Promise<void> {
    application.status = status;
    application.reasonCode =
      reasonCode?.slice(0, CARD_APPLICATION_REASON_CODE_MAX_LENGTH) ?? null;
    application.message =
      message?.slice(0, CARD_APPLICATION_MESSAGE_MAX_LENGTH) ?? null;
    await this.applicationRepository.save(application);
  }
}
