import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { truncateToColumn } from '../../shared/persistence/column-text.util';
import { isDuplicateEntryError } from '../../shared/persistence/duplicate-entry.util';
import { CardCapability } from '../domain/card-capability.enum';
import {
  CardCallbackContext,
  CardCallbackReading,
} from '../domain/card-issuer.port';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import {
  CARD_PROVIDER_CALLBACK_DEDUPE_INDEX,
  CARD_PROVIDER_CALLBACK_DELIVERY_KEY_MAX_LENGTH,
  CARD_PROVIDER_CALLBACK_EVENT_LABEL_MAX_LENGTH,
  CARD_PROVIDER_CALLBACK_LAST_ERROR_MAX_LENGTH,
  CardProviderCallbackEntity,
} from '../infrastructure/persistence/card-provider-callback.entity';
import { assertCardCapability } from './assert-card-capability';
import { CardProviderCallbackDispatcher } from './card-provider-callback.dispatcher';

/** What the route sends back. `contentType` must describe `body` truthfully. */
export interface CardCallbackResponse {
  status: number;
  body: string;
  contentType: string;
}

/**
 * Answers that are deliberately **not** an issuer's acknowledgement, so its
 * retry ladder delivers the event again.
 */
const REFUSED: CardCallbackResponse = {
  status: 401,
  body: 'callback signature verification failed',
  contentType: 'text/plain',
};

const FAILED: CardCallbackResponse = {
  status: 500,
  body: 'callback processing failed',
  contentType: 'text/plain',
};

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * Receives one callback from a card issuer: records it before anything else,
 * refuses it if it does not verify, and answers what that issuer counts as
 * delivery.
 */
@Injectable()
export class ProcessCardProviderCallbackUseCase {
  private readonly logger = new Logger(ProcessCardProviderCallbackUseCase.name);

  constructor(
    @InjectRepository(CardProviderCallbackEntity)
    private readonly callbackRepository: Repository<CardProviderCallbackEntity>,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
    private readonly dispatcher: CardProviderCallbackDispatcher,
  ) {}

  async execute(
    providerKey: string,
    context: CardCallbackContext,
  ): Promise<CardCallbackResponse> {
    // Refused before anything is written: a delivery no provider owns has
    // nothing to be recorded against.
    const key = providerKey.toUpperCase() as CardProviderKey;
    const issuer = this.cardIssuerRegistry.resolve(key);
    assertCardCapability(
      issuer,
      CardCapability.CALLBACK_EVENTS,
      key,
      'provider callbacks',
    );

    const reading = await issuer.readCallback(context);
    const row = await this.record(key, reading, context);

    if (row === null) {
      // Another writer holds it and is answering for it; refusing would earn a
      // retry of an event already in hand.
      this.logger.log(
        `A ${key} callback collided with a delivery this process cannot read back: delivery=${reading.deliveryKey}`,
      );
      return issuer.callbackAck();
    }

    if (!reading.signatureValid) {
      this.logger.warn(
        `Refused a ${key} callback that did not verify: label=${reading.label ?? 'NONE'} delivery=${reading.deliveryKey}. ` +
          `The inbound headers are on the recorded row; the issuer's retry delivers it again once the verifier is right.`,
      );
      return REFUSED;
    }

    if (row.processedAt !== null) {
      // Acting twice on one delivery is what this table exists to prevent.
      this.logger.log(
        `Ignored a redelivered ${key} callback already processed at ${row.processedAt.toISOString()}: delivery=${reading.deliveryKey}`,
      );
      return issuer.callbackAck();
    }

    try {
      // Everything a verified delivery needs done to it belongs in this try: a
      // failure leaves `processed_at` null, so the next retry does the work
      // rather than colliding with a row already marked finished — which is
      // why the stamp goes last.
      await this.dispatcher.dispatch(key, reading.event);
      await this.callbackRepository.update(
        { id: row.id },
        { processedAt: new Date(), lastError: null },
      );
    } catch (error) {
      await this.recordFailure(row.id, error);
      return FAILED;
    }

    return issuer.callbackAck();
  }

  /**
   * Writes the delivery down, or finds the row that already holds it.
   *
   * **Insert first and handle the collision**, never read-then-write: two
   * deliveries in flight together both see no row, and only the unique index
   * can decide which is the duplicate.
   */
  private async record(
    providerKey: CardProviderKey,
    reading: CardCallbackReading,
    context: CardCallbackContext,
  ): Promise<CardProviderCallbackEntity | null> {
    // Never truncated: this is an identity, and cutting one is how two
    // deliveries become one.
    if (
      reading.deliveryKey.length >
      CARD_PROVIDER_CALLBACK_DELIVERY_KEY_MAX_LENGTH
    ) {
      throw new Error(
        `Card provider "${providerKey}" produced a ${reading.deliveryKey.length}-character delivery key, past the ${CARD_PROVIDER_CALLBACK_DELIVERY_KEY_MAX_LENGTH} the callback inbox holds`,
      );
    }

    try {
      return await this.callbackRepository.save(
        this.callbackRepository.create({
          providerKey,
          eventLabel:
            reading.label === null
              ? null
              : truncateToColumn(
                  reading.label,
                  CARD_PROVIDER_CALLBACK_EVENT_LABEL_MAX_LENGTH,
                ),
          signatureValid: reading.signatureValid,
          payload: { ...context.payload },
          // The bag is what diagnoses a verifier that does not work, and worth
          // nothing once one does.
          headers: reading.signatureValid ? null : { ...context.headers },
          deliveryKey: reading.deliveryKey,
          attemptCount: 1,
        }),
      );
    } catch (error) {
      if (!isDuplicateEntryError(error, CARD_PROVIDER_CALLBACK_DEDUPE_INDEX)) {
        throw error;
      }

      // Only a verified row can hold the key that collided — a refused one
      // leaves the generated column null and never occupies it. Null rather
      // than a throw when it cannot be read back: the constraint already
      // proves the delivery is recorded.
      const existing = await this.callbackRepository.findOneBy({
        providerKey,
        deliveryKey: reading.deliveryKey,
        signatureValid: true,
      });
      if (existing === null) return null;

      await this.callbackRepository.increment(
        { id: existing.id },
        'attemptCount',
        1,
      );
      return existing;
    }
  }

  private async recordFailure(id: string, error: unknown): Promise<void> {
    const reason = describe(error);
    this.logger.error(
      `Processing a card provider callback failed, leaving it unprocessed for their retry: ${reason}`,
    );
    await this.callbackRepository.update(
      { id },
      {
        lastError: truncateToColumn(
          reason,
          CARD_PROVIDER_CALLBACK_LAST_ERROR_MAX_LENGTH,
        ),
      },
    );
  }
}
