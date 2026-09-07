import { ForbiddenException } from '@nestjs/common';
import { CardCapability } from '../domain/card-capability.enum';
import { supportsCapability } from '../domain/card-issuer-guards';
import { CardIssuerPort } from '../domain/card-issuer.port';
import { CardProviderKey } from '../domain/card-provider-key.enum';

/**
 * Refuses an operation the resolved issuer does not declare support for. The
 * branch is always the capability, never the provider key.
 */
export const assertCardCapability = (
  issuer: CardIssuerPort,
  capability: CardCapability,
  providerKey: CardProviderKey,
  description: string,
): void => {
  if (supportsCapability(issuer, capability)) return;

  throw new ForbiddenException(
    `Card provider "${providerKey}" does not support ${description}`,
  );
};
