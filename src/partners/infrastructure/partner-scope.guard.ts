import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../../identity/infrastructure/jwt/jwt-auth.guard';

/**
 * Defense-in-depth for /dashboard/* routes: even though @Roles(PARTNER)
 * already restricts these routes, this guard additionally refuses any
 * request where the JWT carries no partnerId — protecting against a future
 * bug that assigns the PARTNER role to a non-partner-scoped user.
 */
@Injectable()
export class PartnerScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user.partnerId) {
      throw new ForbiddenException(
        'This route requires a partner-scoped account',
      );
    }
    return true;
  }
}
