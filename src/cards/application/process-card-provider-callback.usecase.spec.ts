import {
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { CardCapability } from '../domain/card-capability.enum';
import { CardCallbackReading } from '../domain/card-issuer.port';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import {
  CARD_PROVIDER_CALLBACK_DEDUPE_INDEX,
  CARD_PROVIDER_CALLBACK_EVENT_LABEL_MAX_LENGTH,
  CARD_PROVIDER_CALLBACK_LAST_ERROR_MAX_LENGTH,
  CardProviderCallbackEntity,
} from '../infrastructure/persistence/card-provider-callback.entity';
import { CardProviderCallbackDispatcher } from './card-provider-callback.dispatcher';
import { ProcessCardProviderCallbackUseCase } from './process-card-provider-callback.usecase';

/** The stamp a processed row carries; its value is the clock's, not this file's. */
const ANY_DATE = expect.any(Date) as unknown as Date;

/** Their acknowledgement, as their page defines it. */
const THEIR_ACK = {
  status: 200,
  body: '{"code":1,"msg":"ok","data":{}}',
  contentType: 'application/json',
};

/**
 * The duplicate the inbox's unique index raises. Built by hand rather than by
 * a real write, because `isDuplicateEntryError` reads the index out of the
 * driver's message and that is the part under test.
 */
const dedupeCollision = (): QueryFailedError => {
  const error = new QueryFailedError('INSERT', [], new Error('duplicate'));
  Object.assign(error, {
    code: 'ER_DUP_ENTRY',
    sqlMessage: `Duplicate entry 'x' for key '${CARD_PROVIDER_CALLBACK_DEDUPE_INDEX}'`,
  });
  return error;
};

describe('ProcessCardProviderCallbackUseCase', () => {
  let useCase: ProcessCardProviderCallbackUseCase;
  let repository: {
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    increment: jest.Mock;
    findOneBy: jest.Mock;
  };
  let registry: { resolve: jest.Mock };
  let dispatcher: { dispatch: jest.Mock };
  let issuer: {
    capabilities: Set<CardCapability>;
    readCallback: jest.Mock;
    callbackAck: jest.Mock;
  };

  const headers = {
    timestamp: '1747984101',
    nonce: 'a1b2c3d4e5',
    'api-key': 'merchant-key',
    signature: 'ZmFrZQ==',
  };

  const payload = {
    notify_type: 'CARD_CONFIG_CHANGE',
    card_type_id: '40000002',
  };

  const reading = (
    overrides: Partial<CardCallbackReading> = {},
  ): CardCallbackReading => ({
    signatureValid: true,
    deliveryKey: 'a'.repeat(64),
    label: 'CARD_CONFIG_CHANGE',
    event: { kind: 'PRODUCT_CATALOGUE' },
    ...overrides,
  });

  /** The row a save answers with — id assigned, nothing acted on yet. */
  const savedRow = (
    overrides: Partial<CardProviderCallbackEntity> = {},
  ): CardProviderCallbackEntity =>
    ({
      id: '41',
      processedAt: null,
      attemptCount: 1,
      lastError: null,
      ...overrides,
    }) as CardProviderCallbackEntity;

  const execute = (
    providerKey = 'hypercard',
  ): ReturnType<ProcessCardProviderCallbackUseCase['execute']> =>
    useCase.execute(providerKey, { payload, headers });

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    repository = {
      create: jest.fn((row: unknown) => row),
      save: jest.fn(() => Promise.resolve(savedRow())),
      update: jest.fn(() => Promise.resolve({ affected: 1 })),
      increment: jest.fn(() => Promise.resolve({ affected: 1 })),
      findOneBy: jest.fn(),
    };

    issuer = {
      capabilities: new Set([CardCapability.CALLBACK_EVENTS]),
      readCallback: jest.fn(() => Promise.resolve(reading())),
      callbackAck: jest.fn(() => THEIR_ACK),
    };

    registry = { resolve: jest.fn(() => issuer) };
    dispatcher = { dispatch: jest.fn(() => Promise.resolve()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProcessCardProviderCallbackUseCase,
        {
          provide: getRepositoryToken(CardProviderCallbackEntity),
          useValue: repository,
        },
        { provide: CardIssuerRegistry, useValue: registry },
        { provide: CardProviderCallbackDispatcher, useValue: dispatcher },
      ],
    }).compile();

    useCase = module.get(ProcessCardProviderCallbackUseCase);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('before anything is written', () => {
    it('resolves the provider from the path, upper-cased', async () => {
      await execute('hypercard');

      expect(registry.resolve).toHaveBeenCalledWith(CardProviderKey.HYPERCARD);
    });

    it('refuses a provider that is unknown or switched off', async () => {
      registry.resolve.mockImplementation(() => {
        throw new BadRequestException('not enabled');
      });

      await expect(execute('nosuchprovider')).rejects.toThrow(
        BadRequestException,
      );
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('refuses a provider that does not declare callbacks', async () => {
      // A delivery nothing can attribute to a provider that pushes has nothing
      // to be recorded against.
      issuer.capabilities = new Set();

      await expect(execute()).rejects.toThrow(ForbiddenException);
      expect(issuer.readCallback).not.toHaveBeenCalled();
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  describe('a delivery that does not verify', () => {
    beforeEach(() => {
      issuer.readCallback.mockResolvedValue(reading({ signatureValid: false }));
    });

    it('answers something other than their acknowledgement', async () => {
      // Their retry ladder is the recovery mechanism, and acknowledging an
      // unverified delivery throws it away — they stop retrying on success.
      const response = await execute();

      expect(response.status).toBe(401);
      expect(response.body).not.toBe(THEIR_ACK.body);
      expect(issuer.callbackAck).not.toHaveBeenCalled();
    });

    it('records it with the headers it arrived with', async () => {
      await execute();

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          providerKey: CardProviderKey.HYPERCARD,
          signatureValid: false,
          payload,
          headers,
        }),
      );
    });

    it('leaves it unprocessed', async () => {
      await execute();

      expect(repository.update).not.toHaveBeenCalled();
    });

    it('is never acted on', async () => {
      await execute();

      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });
  });

  describe('a delivery that verifies', () => {
    it('records it and answers with their acknowledgement', async () => {
      const response = await execute();

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          providerKey: CardProviderKey.HYPERCARD,
          eventLabel: 'CARD_CONFIG_CHANGE',
          signatureValid: true,
          payload,
          deliveryKey: 'a'.repeat(64),
          attemptCount: 1,
        }),
      );
      expect(response).toEqual(THEIR_ACK);
    });

    it('retains no headers', async () => {
      // The bag diagnoses a verifier that does not work and is worth nothing
      // once one does, so keeping it on every accepted delivery is retention
      // with no reader.
      await execute();

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ headers: null }),
      );
    });

    it('marks it processed', async () => {
      await execute();

      expect(repository.update).toHaveBeenCalledWith(
        { id: '41' },
        expect.objectContaining({ processedAt: ANY_DATE }),
      );
    });

    it('acts on it under the provider it arrived on', async () => {
      await execute();

      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        CardProviderKey.HYPERCARD,
        { kind: 'PRODUCT_CATALOGUE' },
      );
    });

    it('acts on it before the stamp that would retire their retry', async () => {
      const order: string[] = [];
      dispatcher.dispatch.mockImplementation(() => {
        order.push('dispatch');
        return Promise.resolve();
      });
      repository.update.mockImplementation(() => {
        order.push('update');
        return Promise.resolve({ affected: 1 });
      });

      await execute();

      expect(order).toEqual(['dispatch', 'update']);
    });

    it('finishes an event type nothing here acts on', async () => {
      // Recorded, acknowledged and done: retrying an event this codebase has
      // no use for would deliver the same thing seven more times.
      issuer.readCallback.mockResolvedValue(
        reading({
          label: 'OPT_CODE',
          event: { kind: 'UNHANDLED', label: 'OPT_CODE' },
        }),
      );

      const response = await execute();

      expect(response).toEqual(THEIR_ACK);
      expect(repository.update).toHaveBeenCalledWith(
        { id: '41' },
        expect.objectContaining({ processedAt: ANY_DATE }),
      );
    });

    it('records a card status change under the label it arrived with', async () => {
      issuer.readCallback.mockResolvedValue(
        reading({
          label: 'CARD_STATUS_CHANGE',
          event: {
            kind: 'CARD_STATUS',
            providerCardId: '6232931889900031321',
            status: CardStatus.ON_HOLD,
          },
        }),
      );

      await execute();

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ eventLabel: 'CARD_STATUS_CHANGE' }),
      );
    });

    it('records a body that named no event at all', async () => {
      // A body carrying nothing recognisable still has to land, or the
      // refusal most needing diagnosis is the one that cannot be written down.
      issuer.readCallback.mockResolvedValue(
        reading({ label: null, event: { kind: 'UNHANDLED', label: null } }),
      );

      await execute();

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ eventLabel: null }),
      );
    });

    it('cuts a label longer than the column holds', async () => {
      issuer.readCallback.mockResolvedValue(
        reading({ label: 'X'.repeat(200) }),
      );

      await execute();

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventLabel: 'X'.repeat(CARD_PROVIDER_CALLBACK_EVENT_LABEL_MAX_LENGTH),
        }),
      );
    });
  });

  describe('a redelivery', () => {
    beforeEach(() => {
      repository.save.mockRejectedValue(dedupeCollision());
    });

    it('loads the row the constraint refused rather than failing', async () => {
      // Insert first and handle the collision: two deliveries of one event in
      // flight together both see no row, and only the index decides.
      repository.findOneBy.mockResolvedValue(savedRow());

      const response = await execute();

      expect(repository.findOneBy).toHaveBeenCalledWith({
        providerKey: CardProviderKey.HYPERCARD,
        deliveryKey: 'a'.repeat(64),
        // Only a verified row can hold the key that collided.
        signatureValid: true,
      });
      expect(response).toEqual(THEIR_ACK);
    });

    it('counts the delivery on the row that already exists', async () => {
      repository.findOneBy.mockResolvedValue(savedRow());

      await execute();

      expect(repository.increment).toHaveBeenCalledWith(
        { id: '41' },
        'attemptCount',
        1,
      );
    });

    it('does not act on one that was already processed', async () => {
      repository.findOneBy.mockResolvedValue(
        savedRow({ processedAt: new Date('2026-08-25T09:15:30.500Z') }),
      );

      const response = await execute();

      expect(response).toEqual(THEIR_ACK);
      expect(repository.update).not.toHaveBeenCalled();
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('does the work when the earlier delivery left it unprocessed', async () => {
      // The whole point of leaving `processed_at` null on a failure: their
      // next retry has to do the work rather than be swallowed by the
      // constraint that exists to protect it.
      repository.findOneBy.mockResolvedValue(savedRow());

      await execute();

      expect(repository.update).toHaveBeenCalledWith(
        { id: '41' },
        expect.objectContaining({ processedAt: ANY_DATE }),
      );
    });

    it('acknowledges when the colliding row cannot be read back', async () => {
      // The constraint already proves the delivery is recorded, so the reader
      // is behind the writer that holds it. Answering as though nothing were
      // recorded would earn a retry of an event already in hand.
      repository.findOneBy.mockResolvedValue(null);

      const response = await execute();

      expect(response).toEqual(THEIR_ACK);
      expect(repository.increment).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('propagates a duplicate on any other constraint unchanged', async () => {
      const other = new QueryFailedError('INSERT', [], new Error('duplicate'));
      Object.assign(other, {
        code: 'ER_DUP_ENTRY',
        sqlMessage: "Duplicate entry 'x' for key 'uq_something_else'",
      });
      repository.save.mockRejectedValue(other);

      await expect(execute()).rejects.toBe(other);
    });
  });

  it('refuses a delivery key wider than the inbox holds, before writing', async () => {
    // Never truncated: the key is an identity, and cutting one is how two
    // deliveries become one. An adapter minting a longer one is our bug, and
    // it is named rather than left to surface as a column-width error.
    issuer.readCallback.mockResolvedValue(
      reading({ deliveryKey: 'k'.repeat(200) }),
    );

    await expect(execute()).rejects.toThrow(/delivery key/);
    expect(repository.save).not.toHaveBeenCalled();
  });

  describe('a delivery whose processing fails', () => {
    beforeEach(() => {
      repository.update.mockImplementation((_where, values: unknown) =>
        (values as { processedAt?: Date }).processedAt
          ? Promise.reject(new Error('the database went away'))
          : Promise.resolve({ affected: 1 }),
      );
    });

    it('answers something other than their acknowledgement', async () => {
      const response = await execute();

      expect(response.status).toBe(500);
      expect(response.body).not.toBe(THEIR_ACK.body);
    });

    it('records why, and leaves the row unprocessed for their retry', async () => {
      await execute();

      expect(repository.update).toHaveBeenLastCalledWith(
        { id: '41' },
        { lastError: 'Error: the database went away' },
      );
    });

    it('leaves a failed handler unprocessed for their retry', async () => {
      repository.update.mockResolvedValue({ affected: 1 });
      dispatcher.dispatch.mockRejectedValue(new Error('the issuer timed out'));

      const response = await execute();

      expect(response.status).toBe(500);
      expect(repository.update).toHaveBeenCalledTimes(1);
      expect(repository.update).toHaveBeenCalledWith(
        { id: '41' },
        { lastError: 'Error: the issuer timed out' },
      );
    });

    it('cuts a reason longer than the column holds', async () => {
      repository.update.mockImplementation((_where, values: unknown) =>
        (values as { processedAt?: Date }).processedAt
          ? Promise.reject(new Error('X'.repeat(2000)))
          : Promise.resolve({ affected: 1 }),
      );

      await execute();

      const [, values] = repository.update.mock.calls.at(-1) as [
        unknown,
        { lastError: string },
      ];
      expect(values.lastError).toHaveLength(
        CARD_PROVIDER_CALLBACK_LAST_ERROR_MAX_LENGTH,
      );
    });
  });
});
