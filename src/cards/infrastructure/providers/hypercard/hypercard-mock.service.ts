import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HyperCardHttpClient } from './hypercard-http-client.service';
import {
  isHyperCardRefusal,
  toHyperCardConflict,
} from './hypercard-refusal.util';
import {
  HYPERCARD_CARD_NOT_HELD_CODE,
  HYPERCARD_CLIENT_ERROR_CODE,
} from './hypercard.types';

/**
 * Their mock endpoints. Three of the five are written without a leading slash
 * on their own pages; the transport strips trailing slashes from the base URL
 * and concatenates, so the slash has to be supplied here.
 */
const MOCK_TX_CONSUME_PATH = '/openapi/card/mock/tx/consume';
const MOCK_3DS_PATH = '/openapi/card/mock/3ds';
const MOCK_BINDING_PATH = '/openapi/card/mock/binding';
const MOCK_ADD_BALANCE_PATH = '/openapi/card/mock/add/balance';
const MOCK_TX_RESEND_PATH = '/openapi/card/mock/tx/resend';

const SANDBOX_ENV = 'sandbox';

/** What their consume mock declines with. Every other code is a fault and propagates. */
const MOCK_CONSUME_REFUSAL_CODES = [
  HYPERCARD_CLIENT_ERROR_CODE,
  HYPERCARD_CARD_NOT_HELD_CODE,
] as const;

/** Their "Mock tx consume" page: type defaults to consume, status to success. */
const DEFAULT_TRANSACTION_TYPE = 1;
const DEFAULT_TRANSACTION_STATUS = 1;

/**
 * How far ahead `expired_time` defaults to. Their page requires only that it
 * be greater than the current time, so this is our choice: long enough to
 * authorise the challenge by hand, short enough that a forgotten one expires.
 */
const DEFAULT_3DS_VALIDITY_SECONDS = 15 * 60;

/**
 * Their "Transaction type" appendix, minus the three codes their mock consume
 * page excludes: recharge, purchase crypto coin, and cancel card. Those have
 * their own endpoints and are rejected on their side here.
 */
export const HYPERCARD_MOCK_CONSUME_TRANSACTION_TYPES = [
  1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 100,
] as const;

/** Their "Mock tx consume" page: 1 success, 2 failed. */
export const HYPERCARD_MOCK_TRANSACTION_STATUSES = [1, 2] as const;

/**
 * `cardId` throughout this file is HyperCard's own card id, not our card
 * `public_id`. Nothing here resolves a local row: their binding mock generates
 * a card before one exists on our side at all.
 */
export interface HyperCardMockConsumeInput {
  cardId: string;
  description: string;
  /** Applicable for certain card types. A decimal string, never a number. */
  fee: string;
  /** Unix timestamp in seconds, as a string — their spec's format. */
  transactionDate: string;
  txAmount: string;
  txAmountUsd: string;
  /** Their transaction-type codes. Defaults to consume. */
  type?: number;
  /** 1 success, 2 failed. Defaults to success. */
  status?: number;
}

export interface HyperCardMock3dsInput {
  cardId: string;
  txnAmount: string;
  /** Unix seconds. Defaults to now. */
  createdTime?: number;
  /** Unix seconds, must be in the future. Defaults to 15 minutes from now. */
  expiredTime?: number;
}

export interface HyperCardMockBindingCard {
  cardNumber: string;
  secret: string;
  cardTypeId: string;
}

export interface HyperCardMockCoinBalance {
  coin: string;
  balance: string;
}

/** One row of their "Mock Binding Data" response. */
interface HyperCardMockBindingRow {
  card_number: string;
  secret: string;
  card_type_id: string;
}

/** One row of their "Mock Add Balance" response. */
interface HyperCardMockBalanceRow {
  coin: string;
  balance: string;
}

/**
 * Drives HyperCard's sandbox mock endpoints so a developer can provoke a
 * lifecycle event on demand. Nothing here writes a row — the state these calls
 * create lives on HyperCard's side and comes back as a push event.
 */
@Injectable()
export class HyperCardMockService {
  private readonly logger = new Logger(HyperCardMockService.name);

  constructor(
    private readonly httpClient: HyperCardHttpClient,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Their mock pages state these endpoints exist only in their test
   * environment. Positive test, never `!== 'production'`: an environment name
   * this code has never heard of must fail closed.
   */
  private assertSandbox(): void {
    const env = this.configService.getOrThrow<string>('PAYMENTS_HYPERCARD_ENV');
    if (env !== SANDBOX_ENV) {
      throw new ForbiddenException(
        `HyperCard mock endpoints exist only in their sandbox; PAYMENTS_HYPERCARD_ENV is "${env}"`,
      );
    }
  }

  /**
   * Generates a consume transaction, which their `CONSUME` push event then
   * announces and their single- and multi-card transaction endpoints can read
   * back.
   */
  async mockTxConsume(
    input: HyperCardMockConsumeInput,
  ): Promise<{ cardId: string; type: number; status: number }> {
    this.assertSandbox();

    const type = input.type ?? DEFAULT_TRANSACTION_TYPE;
    const status = input.status ?? DEFAULT_TRANSACTION_STATUS;

    this.logger.log(
      `Mocking a consume transaction on card ${input.cardId} (type=${type}, status=${status})`,
    );

    try {
      await this.httpClient.postForAck(
        'mock transaction consume',
        MOCK_TX_CONSUME_PATH,
        {
          card_id: input.cardId,
          description: input.description,
          fee: input.fee,
          transaction_date: input.transactionDate,
          tx_amount: input.txAmount,
          tx_amount_usd: input.txAmountUsd,
          type,
          status,
        },
      );
    } catch (error) {
      if (isHyperCardRefusal(error, MOCK_CONSUME_REFUSAL_CODES)) {
        this.logger.warn(
          `HyperCard refused a mock transaction on card ${input.cardId}: ${error.message}`,
        );
        throw toHyperCardConflict(error);
      }

      throw error;
    }

    return { cardId: input.cardId, type, status };
  }

  /**
   * Generates a 3DS authorisation challenge, which arrives as their `AUTH_3DS`
   * push event and is then resolved through their "3ds transaction auth" and
   * "3ds transaction auth status" endpoints.
   */
  async mock3dsTx(
    input: HyperCardMock3dsInput,
  ): Promise<{ cardId: string; createdTime: number; expiredTime: number }> {
    this.assertSandbox();

    const nowSeconds = Math.floor(Date.now() / 1000);
    const createdTime = input.createdTime ?? nowSeconds;
    const expiredTime =
      input.expiredTime ?? nowSeconds + DEFAULT_3DS_VALIDITY_SECONDS;

    this.logger.log(
      `Mocking a 3DS transaction on card ${input.cardId} (expires at ${expiredTime})`,
    );

    await this.httpClient.postForAck('mock 3DS transaction', MOCK_3DS_PATH, {
      card_id: input.cardId,
      txn_amount: input.txnAmount,
      // Their page contradicts itself here: the parameter table calls this
      // `created_Time`, the example request body `created_time`. We follow the
      // example body. Unresolved against a live call; if their endpoint rejects
      // it, the capitalised spelling is the thing to try.
      created_time: createdTime,
      expired_time: expiredTime,
    });

    return { cardId: input.cardId, createdTime, expiredTime };
  }

  /**
   * Generates card binding data — a card number and secret — for testing their
   * "Binding" endpoint.
   */
  async mockBindingData(
    cardTypeId: string,
  ): Promise<{ cards: HyperCardMockBindingCard[] }> {
    this.assertSandbox();

    this.logger.log(`Mocking binding data for card type ${cardTypeId}`);

    const rows = await this.httpClient.post<HyperCardMockBindingRow[]>(
      'mock binding data',
      MOCK_BINDING_PATH,
      { card_type_id: cardTypeId },
    );

    return {
      cards: rows.map((row) => ({
        cardNumber: row.card_number,
        secret: row.secret,
        cardTypeId: row.card_type_id,
      })),
    };
  }

  /**
   * Tops up our sandbox merchant float, which is what their "balance is
   * insufficient" code means when it comes back from an application or
   * recharge.
   */
  async mockAddBalance(): Promise<{
    credited: boolean;
    balances: HyperCardMockCoinBalance[];
  }> {
    this.assertSandbox();

    this.logger.log('Mocking a merchant balance top-up');

    // Their page documents no request parameters at all. An empty body is
    // signed as headers only, since the canonical string builder drops empty
    // containers.
    const rows = await this.httpClient.postForOptionalData<
      HyperCardMockBalanceRow[]
    >('mock add balance', MOCK_ADD_BALANCE_PATH, {});

    const balances = (rows ?? []).map((row) => ({
      coin: row.coin,
      balance: row.balance,
    }));

    return { credited: balances.length > 0, balances };
  }

  /**
   * Re-emits an existing transaction so their `TRANSACTION_CHANGE` push event
   * fires again — the only way to exercise that event, and the one that makes
   * a replayed-event test possible.
   */
  async mockTxResend(
    cardId: string,
    txid: string,
  ): Promise<{ cardId: string; txid: string }> {
    this.assertSandbox();

    this.logger.log(
      `Mocking a transaction resend for ${txid} on card ${cardId}`,
    );

    await this.httpClient.postForAck(
      'mock transaction resend',
      MOCK_TX_RESEND_PATH,
      { card_id: cardId, txid },
    );

    return { cardId, txid };
  }
}
