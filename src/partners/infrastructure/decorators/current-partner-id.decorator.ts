import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedRequest } from '../../../identity/infrastructure/jwt/jwt-auth.guard';

/** Extracts the caller's partnerId from the JWT. Only valid on routes behind PartnerScopeGuard. */
export const CurrentPartnerId = createParamDecorator(
  (_: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // PartnerScopeGuard already guarantees this is non-null before the handler runs.
    return request.user.partnerId as string;
  },
);
