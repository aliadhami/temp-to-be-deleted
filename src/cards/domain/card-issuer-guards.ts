import { CardCapability } from './card-capability.enum';
import { CardIssuerPort } from './card-issuer.port';

export const supportsCapability = (
  issuer: CardIssuerPort,
  capability: CardCapability,
): boolean => issuer.capabilities.has(capability);
