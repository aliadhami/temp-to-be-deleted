import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { JwtPayload } from '../../domain/jwt-payload.model';
import { AuthenticatedRequest } from '../jwt/jwt-auth.guard';

export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext): JwtPayload => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user;
  },
);
