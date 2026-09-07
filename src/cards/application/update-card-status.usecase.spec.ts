import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { WebhookDeliveryService } from '../../payments/infrastructure/webhooks/webhook-delivery.service';
import { CardActivationStatus } from '../domain/card-activation-status.enum';
import { CardCapability } from '../domain/card-capability.enum';
import { CardLifecycleOperation } from '../domain/card-lifecycle-operation.enum';
import { CardLifecycleOperationResult } from '../domain/card-issuer.port';
import { CardOperationStatus } from '../domain/card-operation-status.enum';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { CardProviderThrottledError } from '../domain/card-provider-throttled.error';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardApplicationEntity } from '../infrastructure/persistence/card-application.entity';
import {
  CARD_OPERATION_IN_FLIGHT_INDEX,
  CardOperationEntity,
} from '../infrastructure/persistence/card-operation.entity';
import { CardEventEntity } from '../infrastructure/persistence/card-event.entity';
import { CardEntity } from '../infrastructure/persistence/card.entity';
import { CardOperationAvailability } from './card-operation-availability';
import { CardProductResolver } from './card-product-resolver';
import { UpdateCardStatusUseCase } from './update-card-status.usecase';

/** The reference the entity's insert hook would have minted. */
const REFERENCE = '48d27417-47a4-49b2-968a-91e2523feb22';

/**
 * The duplicate-key failure the in-flight index raises. Shaped as the driver
 * shapes it, because `isDuplicateEntryError` reads the index out of the message.
 */
const inFlightCollision = (): QueryFailedError => {
  const error = new QueryFailedError('INSERT', [], new Error('duplicate'));
  Object.assign(error, {
    code: 'ER_DUP_ENTRY',
    sqlMessage: `Duplicate entry '7' for key '${CARD_OPERATION_IN_FLIGHT_INDEX}'`,
  });
  return error;
};

describe('UpdateCardStatusUseCase', () => {
  let useCase: UpdateCardStatusUseCase;
  let cardRepository: { findOne: jest.Mock; update: jest.Mock };
  let cardEventRepository: { create: jest.Mock; save: jest.Mock };
  let operationRepository: {
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    findOne: jest.Mock;
  };
  let applicationRepository: { findOne: jest.Mock };
  let productResolver: { supportedOperationsByProductId: jest.Mock };
  let webhookDeliveryService: { enqueueForCard: jest.Mock };
  let capabilities: Set<CardCapability>;

  const adapter = {
    get capabilities() {
      return capabilities;
    },
    updateCardStatus: jest.fn(),
  };

  const hyperCardCard: Partial<CardEntity> = {
    id: '1',
    publicId: 'card-public-id',
    partnerId: 'partner-1',
    providerKey: CardProviderKey.HYPERCARD,
    providerCardId: '30806984524000022826',
    status: CardStatus.ACTIVE,
    activationStatus: null,
  };

  const axysCard: Partial<CardEntity> = {
    ...hyperCardCard,
    providerKey: CardProviderKey.AXYS,
    providerCardId: 'axys-card-id',
  };

  /** A card the issuer only acknowledges for. */
  const submitted = (
    operation: 'block' | 'unblock' = 'block',
  ): CardLifecycleOperationResult =>
    ({
      state: 'SUBMITTED',
      operation,
      reference: REFERENCE,
    }) satisfies CardLifecycleOperationResult;

  /** A card the issuer changes during the call. */
  const applied = (
    status: CardStatus,
    updated = true,
  ): CardLifecycleOperationResult =>
    ({
      state: 'APPLIED',
      operation: status === CardStatus.ON_HOLD ? 'block' : 'unblock',
      status,
      updated,
    }) satisfies CardLifecycleOperationResult;

  const givenCard = (card: Partial<CardEntity>): void => {
    cardRepository.findOne.mockResolvedValue({ ...card });
  };

  /** What the card's product publishes it accepts. */
  const givenProductOffers = (
    operations: CardLifecycleOperation[] | null,
  ): void => {
    applicationRepository.findOne.mockResolvedValue(
      operations === null ? null : { id: '9', cardProductId: '10' },
    );
    productResolver.supportedOperationsByProductId.mockResolvedValue(
      operations === null ? new Map() : new Map([['10', operations]]),
    );
  };

  const block = () =>
    useCase.execute('partner-1', 'card-public-id', 'on_hold', 'fraud_review');
  const unblock = () =>
    useCase.execute('partner-1', 'card-public-id', 'active', undefined);

  beforeEach(async () => {
    capabilities = new Set([CardCapability.BLOCK]);
    cardRepository = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    cardEventRepository = {
      create: jest.fn((row: unknown) => row),
      save: jest.fn(),
    };
    operationRepository = {
      create: jest.fn((row: Record<string, unknown>) => row),
      save: jest.fn((row: Record<string, unknown>) =>
        Promise.resolve({ ...row, id: '7', requestReference: REFERENCE }),
      ),
      update: jest.fn(),
      findOne: jest.fn(),
    };
    applicationRepository = { findOne: jest.fn() };
    productResolver = { supportedOperationsByProductId: jest.fn() };
    webhookDeliveryService = { enqueueForCard: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UpdateCardStatusUseCase,
        // The real helper, not a stub: this spec is where the read's promise
        // and the write's refusal are proven to be one computation.
        CardOperationAvailability,
        { provide: getRepositoryToken(CardEntity), useValue: cardRepository },
        {
          provide: getRepositoryToken(CardEventEntity),
          useValue: cardEventRepository,
        },
        {
          provide: getRepositoryToken(CardOperationEntity),
          useValue: operationRepository,
        },
        {
          provide: getRepositoryToken(CardApplicationEntity),
          useValue: applicationRepository,
        },
        { provide: CardProductResolver, useValue: productResolver },
        {
          provide: CardIssuerRegistry,
          useValue: {
            resolve: () => adapter,
            capabilitiesOf: () => capabilities,
          },
        },
        {
          provide: WebhookDeliveryService,
          useValue: webhookDeliveryService,
        },
      ],
    }).compile();

    useCase = module.get(UpdateCardStatusUseCase);
    jest.clearAllMocks();
    givenCard(hyperCardCard);
    givenProductOffers([
      CardLifecycleOperation.BLOCK,
      CardLifecycleOperation.UNBLOCK,
    ]);
  });

  describe('an issuer that only acknowledges the request', () => {
    beforeEach(() => {
      adapter.updateCardStatus.mockResolvedValue(submitted());
    });

    it('answers that the operation was submitted, not that the card moved', async () => {
      await expect(block()).resolves.toEqual({
        publicId: 'card-public-id',
        operation: CardLifecycleOperation.BLOCK,
        operationStatus: CardOperationStatus.SUBMITTED,
        cardStatus: CardStatus.ACTIVE,
      });
    });

    it('omits `updated`, which would read as "nothing happened"', async () => {
      await expect(block()).resolves.not.toHaveProperty('updated');
    });

    it('leaves the card alone — no status write, no event, no webhook', async () => {
      // Moving the card here would tell a partner it is blocked while it is
      // still spendable.
      await block();

      expect(cardRepository.update).not.toHaveBeenCalled();
      expect(cardEventRepository.save).not.toHaveBeenCalled();
      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
    });

    it('writes the row before the call and moves it to submitted after', async () => {
      await block();

      expect(operationRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          cardId: '1',
          providerKey: CardProviderKey.HYPERCARD,
          operationType: CardLifecycleOperation.BLOCK,
          status: CardOperationStatus.DRAFT,
        }),
      );
      expect(operationRepository.update).toHaveBeenCalledWith(
        { id: '7' },
        { status: CardOperationStatus.SUBMITTED },
      );
    });

    it('calls the issuer only after the row exists', async () => {
      await block();

      expect(operationRepository.save.mock.invocationCallOrder[0]).toBeLessThan(
        adapter.updateCardStatus.mock.invocationCallOrder[0] as number,
      );
    });

    it('hands the adapter the row’s reference, and a fresh idempotency key', async () => {
      await block();

      const [, intent, , idempotencyKey] = adapter.updateCardStatus.mock
        .calls[0] as [string, { reference: string }, unknown, string];
      expect(intent.reference).toBe(REFERENCE);
      // Not the reference: a card is blocked and unblocked repeatedly, so a
      // stable transport key would make the second block look like a replay.
      expect(idempotencyKey).not.toBe(REFERENCE);
      expect(idempotencyKey).toContain('card-public-id');
    });

    it('unblocks an on-hold card', async () => {
      givenCard({ ...hyperCardCard, status: CardStatus.ON_HOLD });
      adapter.updateCardStatus.mockResolvedValue(submitted('unblock'));

      await expect(unblock()).resolves.toMatchObject({
        operation: CardLifecycleOperation.UNBLOCK,
        operationStatus: CardOperationStatus.SUBMITTED,
        cardStatus: CardStatus.ON_HOLD,
      });
    });
  });

  describe('an issuer that carries the operation out during the call', () => {
    beforeEach(() => {
      givenCard(axysCard);
      givenProductOffers(null);
      adapter.updateCardStatus.mockResolvedValue(applied(CardStatus.ON_HOLD));
    });

    it('answers that the operation was applied, with the card’s new status', async () => {
      await expect(block()).resolves.toEqual({
        publicId: 'card-public-id',
        operation: CardLifecycleOperation.BLOCK,
        operationStatus: CardOperationStatus.APPLIED,
        cardStatus: CardStatus.ON_HOLD,
        updated: true,
      });
    });

    it('moves the card, writes one event and announces it once', async () => {
      await block();

      expect(cardRepository.update).toHaveBeenCalledWith(
        { id: '1', status: CardStatus.ACTIVE },
        { status: CardStatus.ON_HOLD },
      );
      expect(cardEventRepository.save).toHaveBeenCalledTimes(1);
      expect(webhookDeliveryService.enqueueForCard).toHaveBeenCalledWith(
        '1',
        'partner-1',
        'card.status_updated',
        expect.objectContaining({
          eventType: 'card.status_updated',
          cardPublicId: 'card-public-id',
          status: CardStatus.ON_HOLD,
        }),
      );
    });

    it('closes the operation row as applied', async () => {
      await block();

      expect(operationRepository.update).toHaveBeenCalledWith(
        { id: '7' },
        { status: CardOperationStatus.APPLIED },
      );
    });

    it('writes no event and sends no webhook when another writer got there first', async () => {
      // The compare-and-set matched nothing, so this request did not make the
      // transition and must not describe one.
      cardRepository.update.mockResolvedValue({ affected: 0 });
      cardRepository.findOne
        .mockResolvedValueOnce({ ...axysCard })
        .mockResolvedValueOnce({ status: CardStatus.CLOSED });

      const result = await block();

      expect(cardEventRepository.save).not.toHaveBeenCalled();
      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
      // And it reports where the card actually is, not where this request
      // would have put it.
      expect(result).toMatchObject({
        cardStatus: CardStatus.CLOSED,
        updated: false,
      });
    });

    it('still answers when the transition cannot be recorded', async () => {
      // By this point the issuer has applied the change and the card row has
      // moved, so losing the event must not cost the partner the webhook too.
      cardEventRepository.save.mockRejectedValue(new Error('database gone'));

      await expect(block()).resolves.toMatchObject({
        operationStatus: CardOperationStatus.APPLIED,
      });
      expect(webhookDeliveryService.enqueueForCard).toHaveBeenCalled();
    });

    it('writes nothing and announces nothing on an idempotent replay', async () => {
      givenCard({ ...axysCard, status: CardStatus.ON_HOLD });
      adapter.updateCardStatus.mockResolvedValue(
        applied(CardStatus.ON_HOLD, false),
      );

      await expect(block()).resolves.toMatchObject({ updated: false });

      expect(cardRepository.update).not.toHaveBeenCalled();
      expect(cardEventRepository.save).not.toHaveBeenCalled();
      expect(webhookDeliveryService.enqueueForCard).not.toHaveBeenCalled();
    });

    it('never asks an asynchronous issuer for a state the card is already in', async () => {
      capabilities = new Set([
        CardCapability.BLOCK,
        CardCapability.OPERATION_RESULT,
      ]);
      givenCard({ ...hyperCardCard, status: CardStatus.ON_HOLD });

      await expect(block()).resolves.toMatchObject({
        operationStatus: CardOperationStatus.APPLIED,
        cardStatus: CardStatus.ON_HOLD,
        updated: false,
      });

      expect(adapter.updateCardStatus).not.toHaveBeenCalled();
      // Still written and closed: its unique index is the in-flight guard.
      expect(operationRepository.save).toHaveBeenCalled();
      expect(operationRepository.update).toHaveBeenCalledWith(
        { id: '7' },
        { status: CardOperationStatus.APPLIED },
      );
    });

    it('still asks an issuer that settles during the call, which repairs drift', async () => {
      // Its answer carries the card's real status, so drift is corrected.
      givenCard({ ...axysCard, status: CardStatus.ON_HOLD });
      adapter.updateCardStatus.mockResolvedValue(
        applied(CardStatus.ACTIVE, true),
      );

      await expect(block()).resolves.toMatchObject({
        cardStatus: CardStatus.ACTIVE,
      });

      expect(adapter.updateCardStatus).toHaveBeenCalled();
    });

    it('lets an operation in flight refuse the request first', async () => {
      // The card still reads its old status until the operation lands.
      givenCard({ ...axysCard, status: CardStatus.ON_HOLD });
      operationRepository.save.mockRejectedValue(inFlightCollision());

      await expect(block()).rejects.toBeInstanceOf(ConflictException);
      expect(adapter.updateCardStatus).not.toHaveBeenCalled();
    });

    it('still refuses an operation the product does not offer', async () => {
      capabilities = new Set([
        CardCapability.BLOCK,
        CardCapability.OPERATION_RESULT,
      ]);
      givenProductOffers([CardLifecycleOperation.UNBLOCK]);
      givenCard({ ...hyperCardCard, status: CardStatus.ON_HOLD });

      await expect(block()).rejects.toBeInstanceOf(BadRequestException);
    });

    it('still answers when the partner cannot be notified', async () => {
      webhookDeliveryService.enqueueForCard.mockRejectedValueOnce(
        new Error('the queue is down'),
      );

      await expect(block()).resolves.toMatchObject({
        operationStatus: CardOperationStatus.APPLIED,
      });
    });
  });

  describe('the operations a card actually accepts', () => {
    beforeEach(() => {
      adapter.updateCardStatus.mockResolvedValue(submitted());
    });

    it('refuses an operation this card’s product does not offer, naming the ones it does', async () => {
      givenProductOffers([CardLifecycleOperation.BLOCK]);
      givenCard({ ...hyperCardCard, status: CardStatus.ON_HOLD });

      await expect(unblock()).rejects.toBeInstanceOf(BadRequestException);
      await expect(unblock()).rejects.toThrow(CardLifecycleOperation.BLOCK);
    });

    it('accepts what the same inputs would have published on the card read', async () => {
      // One card, both directions: the read lists an operation and the write
      // takes it; the read omits one and the write refuses it. Two
      // implementations of that is how a partner meets a 400 on a button we
      // drew for them.
      const availability = new CardOperationAvailability(
        { capabilitiesOf: () => capabilities } as never,
        productResolver as never,
      );
      givenProductOffers([CardLifecycleOperation.BLOCK]);

      const [published = []] = await availability.forCards([
        { providerKey: CardProviderKey.HYPERCARD, cardProductId: '10' },
      ]);

      expect(published).toEqual([CardLifecycleOperation.BLOCK]);
      await expect(block()).resolves.toMatchObject({
        operation: CardLifecycleOperation.BLOCK,
      });
      await expect(unblock()).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses everything for a product offering nothing', async () => {
      givenProductOffers([]);

      await expect(block()).rejects.toThrow('no lifecycle operations');
    });

    it('falls back to the capability alone for a card with no product', async () => {
      givenProductOffers(null);

      await expect(block()).resolves.toMatchObject({
        operationStatus: CardOperationStatus.SUBMITTED,
      });
    });

    it('refuses before writing anything or calling the issuer', async () => {
      givenProductOffers([]);

      await expect(block()).rejects.toBeInstanceOf(BadRequestException);

      expect(operationRepository.save).not.toHaveBeenCalled();
      expect(adapter.updateCardStatus).not.toHaveBeenCalled();
    });
  });

  describe('the gates above the write', () => {
    it('is a 404 for another partner’s card', async () => {
      cardRepository.findOne.mockResolvedValue(null);

      await expect(block()).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is a 404 for a card the issuer has not named yet', async () => {
      givenCard({ ...hyperCardCard, providerCardId: null });

      await expect(block()).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is a 403 when the issuer cannot block cards at all', async () => {
      capabilities = new Set();

      await expect(block()).rejects.toBeInstanceOf(ForbiddenException);
      expect(operationRepository.save).not.toHaveBeenCalled();
    });

    it('is a 409 for a card that is neither active nor on hold', async () => {
      givenCard({ ...hyperCardCard, status: CardStatus.NOT_ACTIVATED });

      await expect(block()).rejects.toBeInstanceOf(ConflictException);
      expect(operationRepository.save).not.toHaveBeenCalled();
    });

    it('refuses on the card row alone, without reading the catalogue', async () => {
      // The two guards above are settled from the card already in hand, so a
      // request they refuse should not have paid for the product lookup.
      givenCard({ ...hyperCardCard, status: CardStatus.NOT_ACTIVATED });

      await expect(block()).rejects.toBeInstanceOf(ConflictException);

      expect(applicationRepository.findOne).not.toHaveBeenCalled();
      expect(
        productResolver.supportedOperationsByProductId,
      ).not.toHaveBeenCalled();
    });

    it('is a 409 while an activation is still outstanding', async () => {
      // Only the not-activated reconcile clears those columns and it selects on
      // the card's status, so blocking a card mid-activation would strand it.
      givenCard({
        ...hyperCardCard,
        activationStatus: CardActivationStatus.PENDING,
      });

      await expect(block()).rejects.toThrow('activation awaiting the provider');
      expect(operationRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('a card that already has an operation in flight', () => {
    beforeEach(() => {
      operationRepository.save.mockRejectedValue(inFlightCollision());
      adapter.updateCardStatus.mockResolvedValue(submitted());
    });

    it('is a 409 naming what it collided with, from the constraint', async () => {
      operationRepository.findOne.mockResolvedValue({
        operationType: CardLifecycleOperation.BLOCK,
        createdAt: new Date('2026-08-24T09:00:00.000Z'),
      });

      await expect(block()).rejects.toBeInstanceOf(ConflictException);
      await expect(block()).rejects.toThrow(
        /BLOCK, requested 2026-08-24T09:00:00\.000Z/,
      );
    });

    it('never reaches the issuer', async () => {
      operationRepository.findOne.mockResolvedValue(null);

      await expect(block()).rejects.toBeInstanceOf(ConflictException);
      expect(adapter.updateCardStatus).not.toHaveBeenCalled();
    });

    it('still answers when the colliding row cannot be read back', async () => {
      operationRepository.findOne.mockResolvedValue(null);

      await expect(block()).rejects.toThrow('one at a time');
    });

    it('propagates a duplicate on any other constraint unchanged', async () => {
      const other = new QueryFailedError('INSERT', [], new Error('duplicate'));
      Object.assign(other, {
        code: 'ER_DUP_ENTRY',
        sqlMessage: "Duplicate entry 'x' for key 'uq_something_else'",
      });
      operationRepository.save.mockRejectedValue(other);

      await expect(block()).rejects.toBe(other);
    });
  });

  describe('when the issuer refuses or cannot be reached', () => {
    const refusal = new CardProviderConflictError(
      CardProviderKey.HYPERCARD,
      'A0005',
      'HyperCard card block failed (HTTP 200, code=A0005): Duplicated request',
    );

    it('records a refusal as rejected, so nothing polls a request never taken on', async () => {
      adapter.updateCardStatus.mockRejectedValue(refusal);

      await expect(block()).rejects.toBeInstanceOf(ConflictException);

      expect(operationRepository.update).toHaveBeenCalledWith(
        { id: '7' },
        expect.objectContaining({
          status: CardOperationStatus.REJECTED,
          reasonCode: 'A0005',
        }),
      );
    });

    it('composes the refusal rather than republishing their wire text', async () => {
      adapter.updateCardStatus.mockRejectedValue(refusal);

      await expect(block()).rejects.not.toThrow(/A0005|HTTP 200/);
    });

    describe('an allowance the issuer has already spent', () => {
      const throttled = new CardProviderThrottledError(
        CardProviderKey.HYPERCARD,
        'A0000',
        'HyperCard card block failed (HTTP 200, code=A0000): You have already submitted an Freeze application.',
      );

      it('answers 429, so a partner can tell waiting from a state conflict', async () => {
        adapter.updateCardStatus.mockRejectedValue(throttled);

        // Not another 409: only one of the two is cleared by waiting.
        await expect(block()).rejects.toMatchObject({
          status: HttpStatus.TOO_MANY_REQUESTS,
        });
      });

      it('names the provider, because this API throttles callers too', async () => {
        adapter.updateCardStatus.mockRejectedValue(throttled);

        await expect(block()).rejects.toThrow(/card provider/i);
        // And still never republishes their wire text.
        await expect(block()).rejects.not.toThrow(/A0000|HTTP 200/);
      });

      it('records it as rejected under their code, not as a lost request', async () => {
        adapter.updateCardStatus.mockRejectedValue(throttled);

        await expect(block()).rejects.toBeDefined();

        expect(operationRepository.update).toHaveBeenCalledWith(
          { id: '7' },
          expect.objectContaining({
            status: CardOperationStatus.REJECTED,
            reasonCode: 'A0000',
          }),
        );
      });
    });

    it('records a call that never landed as a submission failure', async () => {
      adapter.updateCardStatus.mockRejectedValue(new Error('socket hang up'));

      await expect(block()).rejects.toThrow('socket hang up');

      expect(operationRepository.update).toHaveBeenCalledWith(
        { id: '7' },
        expect.objectContaining({
          status: CardOperationStatus.SUBMISSION_FAILED,
          reasonCode: 'SUBMISSION_ERROR',
        }),
      );
    });

    it('reports the provider’s failure even when the row cannot be updated', async () => {
      // Without its own guard the bookkeeping error would propagate in place of
      // the provider's, and the caller would hear the symptom not the cause.
      adapter.updateCardStatus.mockRejectedValue(new Error('socket hang up'));
      operationRepository.update.mockRejectedValue(new Error('database gone'));

      await expect(block()).rejects.toThrow('socket hang up');
    });
  });
});
