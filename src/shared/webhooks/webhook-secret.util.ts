import { randomBytes } from 'node:crypto';

/** Generates a high-entropy webhook signing secret, shown to the partner exactly once. */
export const generateWebhookSecret = (): string =>
  randomBytes(32).toString('hex');
