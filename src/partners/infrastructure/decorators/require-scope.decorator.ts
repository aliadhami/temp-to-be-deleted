import { SetMetadata } from '@nestjs/common';
import { ApiKeyScope } from '../../domain/api-key-scope.enum';

export const REQUIRED_SCOPE_KEY = 'requiredApiKeyScope';

export const RequireScope = (
  scope: ApiKeyScope,
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_SCOPE_KEY, scope);
