import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { CardCallbackEvent } from '../../../domain/card-issuer.port';
import { normaliseHyperCardText } from './hypercard-coercion.util';
import { readHyperCardCardStatus } from './hypercard-status.mapper';
import { parseHyperCardTradeNumber } from './hypercard-trade-number.util';
import { HyperCardNotifyType, HyperCardPushEvent } from './hypercard.types';

const logger = new Logger('HyperCardCallbackMapper');

/**
 * An injective rendering of one body: keys sorted at every depth, values
 * through `JSON.stringify`, which escapes strings so content cannot pass for
 * structure.
 *
 * **Never build an identity from the signing canonical string** — it is lossy
 * by design, and two different bodies can render identically under it.
 */
const injectiveBody = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(injectiveBody).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const entries = Object.keys(source)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${injectiveBody(source[key])}`);
    return `{${entries.join(',')}}`;
  }
  // `JSON.stringify` answers undefined for undefined, which is not a string.
  return JSON.stringify(value) ?? 'null';
};

/**
 * What makes two arrivals one delivery. Their events carry no identifier, so
 * the body is all there is to key on — and **headers stay out**, since a retry
 * may carry a fresh `timestamp` and `nonce`.
 */
export const buildHyperCardDeliveryKey = (
  body: Record<string, unknown>,
): string => createHash('sha256').update(injectiveBody(body)).digest('hex');

/** Their longest name is 22 characters; this cap is for anyone else. */
const EVENT_LABEL_MAX_LENGTH = 64;

/** Drops the characters that would forge log records if interpolated raw. */
const stripControlCharacters = (value: string): string =>
  [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join('');

/**
 * Their own name for the event. Null if the body carried none.
 *
 * **Capped and sanitised here, because this is read before the signature is
 * checked** — an unauthenticated caller chooses it, and it reaches a log line.
 */
export const readHyperCardCallbackLabel = (
  body: HyperCardPushEvent,
): string | null => {
  const raw = normaliseHyperCardText(body.notify_type);
  if (raw === null) return null;

  const safe = [...stripControlCharacters(raw)]
    .slice(0, EVENT_LABEL_MAX_LENGTH)
    .join('');
  return safe === '' ? null : safe;
};

/** A reference of ours echoed back, as the canonical UUID a row is stored under. */
const referenceFrom = (raw: unknown): string | null => {
  const wire = normaliseHyperCardText(raw);
  return wire === null ? null : parseHyperCardTradeNumber(wire);
};

const unhandled = (label: string | null): CardCallbackEvent => ({
  kind: 'UNHANDLED',
  label,
});

/** A handled event type whose own fields cannot be read. Never a guess. */
const unreadable = (label: string, detail: string): CardCallbackEvent => {
  logger.warn(
    `HyperCard "${label}" callback acknowledged and ignored — ${detail}`,
  );
  return unhandled(label);
};

/**
 * What one of their pushes is about. **No arm carries an outcome** — a
 * callback says to ask, and the reference or card is what to ask about.
 */
export const mapHyperCardCallbackEvent = (
  body: HyperCardPushEvent,
): CardCallbackEvent => {
  const label = readHyperCardCallbackLabel(body);

  switch (label) {
    case HyperCardNotifyType.OPEN_CARD: {
      const reference = referenceFrom(body.mc_trade_no);
      // Optional on their table, and every application we send carries one —
      // so an absent reference means the card is not ours.
      return reference === null
        ? unreadable(label, 'it carries no application reference of ours')
        : { kind: 'APPLICATION', reference };
    }

    case HyperCardNotifyType.RECHARGE: {
      const reference = referenceFrom(body.mc_trade_no);
      return reference === null
        ? unreadable(label, 'it carries no deposit reference of ours')
        : { kind: 'DEPOSIT', reference };
    }

    case HyperCardNotifyType.OPERATION: {
      const reference = referenceFrom(body.request_number);
      return reference === null
        ? unreadable(label, 'it carries no operation reference of ours')
        : { kind: 'OPERATION', reference };
    }

    case HyperCardNotifyType.CARD_STATUS_CHANGE: {
      const providerCardId = normaliseHyperCardText(body.card_id);
      if (providerCardId === null) {
        return unreadable(label, 'it names no card');
      }

      // The strict read, never the degrading one: an unrecognised code read as
      // `NOT_ACTIVATED` would move a live card backwards.
      const status =
        body.new_status === undefined
          ? null
          : readHyperCardCardStatus(body.new_status);
      if (status === null) {
        return unreadable(
          label,
          `their status "${String(body.new_status)}" is not one this integration reads — check their "Card Application Status" appendix for a value added since`,
        );
      }

      // `old_status` is deliberately unread: refusing when their previous
      // state disagrees with ours would refuse the repair we need.
      return { kind: 'CARD_STATUS', providerCardId, status };
    }

    case HyperCardNotifyType.CARD_CONFIG_CHANGE:
      return { kind: 'PRODUCT_CATALOGUE' };

    default:
      return unhandled(label);
  }
};
