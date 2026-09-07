import { ConfigService } from '@nestjs/config';
import { CredentialEnvironment } from '../../../partners/domain/credential-environment.enum';
import { GatewayKey } from '../../domain/gateway-key.enum';

const ENVIRONMENT_VALUES = new Set<string>(
  Object.values(CredentialEnvironment),
);

export const resolveGatewayEnvironment = (
  configService: ConfigService,
  gatewayKey: GatewayKey,
): CredentialEnvironment => {
  const raw = configService.getOrThrow<string>(`PAYMENTS_${gatewayKey}_ENV`);
  if (!ENVIRONMENT_VALUES.has(raw)) {
    throw new Error(
      `PAYMENTS_${gatewayKey}_ENV has an invalid value "${raw}" — expected one of: ${[...ENVIRONMENT_VALUES].join(', ')}`,
    );
  }
  return raw as CredentialEnvironment;
};
