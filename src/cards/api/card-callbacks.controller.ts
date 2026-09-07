import { Controller, Param, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../../identity/infrastructure/decorators/public.decorator';
import { ProcessCardProviderCallbackUseCase } from '../application/process-card-provider-callback.usecase';

/**
 * Well above the global limit. `ThrottlerGuard` keys on the source address and
 * an issuer pushes from a handful of its own, so all its traffic shares one
 * bucket — and a throttled callback is a 429, which returns hours later
 * looking exactly like the issuer being slow.
 */
const CALLBACK_THROTTLE = { default: { limit: 600, ttl: 60_000 } };

@ApiExcludeController()
@Public()
@Controller('cards/callback')
export class CardCallbacksController {
  constructor(
    private readonly processCardProviderCallbackUseCase: ProcessCardProviderCallbackUseCase,
  ) {}

  /**
   * The address a card issuer is given for its asynchronous results, ours to
   * choose and registered with them.
   *
   * **No guard, by design**: the caller holds no account and no API key of
   * ours, and its own signature is the authentication.
   */
  @Throttle(CALLBACK_THROTTLE)
  @Post(':providerKey')
  async handleCallback(
    @Param('providerKey') providerKey: string,
    @Req() request: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Not a DTO, and not an oversight: `forbidNonWhitelisted` would answer the
    // first event an issuer extends with a 400, then repeat it to every retry.
    const payload = (request.body ?? {}) as Record<string, unknown>;

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers[name.toLowerCase()] = value;
    }

    const result = await this.processCardProviderCallbackUseCase.execute(
      providerKey,
      { payload, headers },
    );

    res.status(result.status).type(result.contentType).send(result.body);
  }
}
