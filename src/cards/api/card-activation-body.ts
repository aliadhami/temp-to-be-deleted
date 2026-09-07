import { INestApplication, PayloadTooLargeException } from '@nestjs/common';
import { json } from 'body-parser';
import type { NextFunction, Request, Response } from 'express';
import { CARD_ACTIVATE_PATH } from './cards.routes';
import { MAX_ACTIVATION_DOCUMENT_LENGTH } from './dto/activate-card.dto';

/** The only method the activation route answers. */
const CARD_ACTIVATION_METHOD = 'PUT';

/**
 * Room for everything on an activation body that is not the document. Generous
 * on purpose — the document's own maximum is what should refuse an over-long
 * request, as a `400` naming the field.
 */
const NON_DOCUMENT_BODY_ALLOWANCE_BYTES = 64 * 1024;

/**
 * How large a body this one route accepts. Derived from the document's maximum
 * rather than picked, so the two cannot drift.
 */
export const CARD_ACTIVATION_BODY_LIMIT_BYTES =
  MAX_ACTIVATION_DOCUMENT_LENGTH + NON_DOCUMENT_BODY_ALLOWANCE_BYTES;

/** body-parser's marker for a body that exceeded the configured limit. */
const isEntityTooLarge = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { type?: unknown }).type === 'entity.too.large';

/**
 * Raises the JSON body limit for the card activation route, and nothing else.
 * This application runs on Express's 100 kb default, because nothing
 * configures a body parser.
 */
export const applyCardActivationBodyLimit = (app: INestApplication): void => {
  const parseActivationBody = json({ limit: CARD_ACTIVATION_BODY_LIMIT_BYTES });

  app.use(
    CARD_ACTIVATE_PATH,
    (request: Request, response: Response, next: NextFunction) => {
      if (request.method !== CARD_ACTIVATION_METHOD) {
        next();
        return;
      }

      parseActivationBody(request, response, (error?: unknown) => {
        // Answered as an exception of ours rather than left as the parser's
        // own, so an oversized request names the field a partner has to shrink
        // instead of reporting an anonymous entity size.
        if (isEntityTooLarge(error)) {
          next(
            new PayloadTooLargeException(
              `Request body is too large — activationDocument must be at most ${MAX_ACTIVATION_DOCUMENT_LENGTH} base64 characters`,
            ),
          );
          return;
        }

        next(error);
      });
    },
  );
};
