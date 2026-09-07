import { Controller, Param, Post, Req, Res } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../../identity/infrastructure/decorators/public.decorator';
import { ProcessGatewayResultUseCase } from '../application/process-gateway-result.usecase';
import { GatewayKey } from '../domain/gateway-key.enum';
import { GatewayCallbackContext } from '../domain/payment-gateway.port';

@ApiExcludeController()
@Public()
@Controller('payments/callback')
export class GatewayCallbacksController {
  constructor(
    private readonly processGatewayResultUseCase: ProcessGatewayResultUseCase,
  ) {}

  @Post(':gatewayKey')
  async handleCallback(
    @Param('gatewayKey') gatewayKey: string,
    @Req() request: RawBodyRequest<Request>,
    @Res() res: Response,
  ): Promise<void> {
    // Raw body AND headers are both required: providers that sign the request
    // (SunPay) HMAC the exact bytes and present the signature in a header, so a
    // re-serialized parsed body would not verify. Enabled by `rawBody: true` in
    // main.ts. Falls back to the serialized body only so a provider that does
    // not sign the raw payload (MLT) still works if rawBody is unavailable.
    const parsedBody = (request.body ?? {}) as Record<string, unknown>;
    const rawBody =
      request.rawBody?.toString('utf8') ?? JSON.stringify(parsedBody);

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers[name.toLowerCase()] = value;
    }

    const context: GatewayCallbackContext = {
      payload: parsedBody,
      rawBody,
      headers,
    };

    const result = await this.processGatewayResultUseCase.execute(
      gatewayKey.toUpperCase() as GatewayKey,
      context,
    );

    if (result.kind === 'REDIRECT') {
      res.redirect(302, result.url);
      return;
    }

    // Content-Type matters: some providers validate the response shape before
    // considering a webhook delivered, and Express would otherwise send a bare
    // string as text/html. The type comes from the adapter because it varies —
    // SunPay acks with JSON, MLT with the plain string `OK`.
    res.status(result.status).type(result.contentType).send(result.body);
  }
}
