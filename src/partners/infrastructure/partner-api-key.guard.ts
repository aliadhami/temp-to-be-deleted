import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ApiKeyScope } from '../domain/api-key-scope.enum';
import { PartnerApiKeyService } from '../application/partner-api-key.service';
import { REQUIRED_SCOPE_KEY } from './decorators/require-scope.decorator';

export interface PartnerAuthenticatedRequest extends Request {
  partner: {
    partnerId: string;
    partnerPublicId: string;
    scopes: ApiKeyScope[];
  };
}

@Injectable()
export class PartnerApiKeyGuard implements CanActivate {
  constructor(
    private readonly apiKeyService: PartnerApiKeyService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<PartnerAuthenticatedRequest>();
    const apiKey = request.headers['x-api-key'];

    if (!apiKey || typeof apiKey !== 'string') {
      throw new UnauthorizedException('Missing X-Api-Key header');
    }

    const result = await this.apiKeyService.verify(apiKey);
    if (!result) {
      throw new UnauthorizedException('Invalid or revoked API key');
    }

    const requiredScope = this.reflector.getAllAndOverride<
      ApiKeyScope | undefined
    >(REQUIRED_SCOPE_KEY, [context.getHandler(), context.getClass()]);
    if (requiredScope && !result.scopes.includes(requiredScope)) {
      throw new ForbiddenException(
        `This API key does not have the "${requiredScope}" scope`,
      );
    }

    request.partner = result;
    return true;
  }
}
