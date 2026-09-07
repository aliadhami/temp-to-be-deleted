import { Injectable, Logger } from '@nestjs/common';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { SunPayConfig } from './sunpay.config';
import { SunPaySignatureService } from './sunpay-signature.service';
import { SunPayEnvelope } from './sunpay.types';

export class SunPayApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly providerCode?: number,
  ) {
    super(message);
    this.name = 'SunPayApiError';
  }
}

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Signed HTTP transport for SunPay.
 *
 * Two details that are easy to get wrong and are the reason this exists as its
 * own class:
 *
 *  1. The signature covers the EXACT request body bytes. The body is serialized
 *     once here and that same string is both signed and written to the socket —
 *     never re-serialized in between, which would risk a different key order or
 *     number formatting and a signature SunPay rejects.
 *  2. Every response is wrapped in an envelope (`is_success`/`code`/`data`).
 *     A 200 with `is_success: false` is a failure; callers get the unwrapped
 *     `data` or an exception, never the envelope.
 */
@Injectable()
export class SunPayHttpClient {
  private readonly logger = new Logger(SunPayHttpClient.name);

  constructor(private readonly signatureService: SunPaySignatureService) {}

  async post<T>(path: string, body: object, config: SunPayConfig): Promise<T> {
    // Serialized exactly once — this same string is signed and sent.
    return this.send<T>('POST', path, JSON.stringify(body), config);
  }

  async get<T>(path: string, config: SunPayConfig): Promise<T> {
    // Bodyless request — the signed payload is timestamp + nonce only.
    return this.send<T>('GET', path, '', config);
  }

  private async send<T>(
    method: 'GET' | 'POST',
    path: string,
    rawBody: string,
    config: SunPayConfig,
  ): Promise<T> {
    const url = new URL(`${config.baseUrl}${path}`);
    const headers: Record<string, string> = {
      ...this.signatureService.buildHeaders({
        apiKey: config.apiKey,
        apiSecret: config.apiSecret,
        rawBody,
      }),
      Accept: 'application/json',
    };

    if (rawBody) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(rawBody).toString();
    }

    const { status, text } = await this.execute(
      method,
      url,
      headers,
      rawBody,
      path,
    );

    let envelope: SunPayEnvelope<T>;
    try {
      envelope = JSON.parse(text) as SunPayEnvelope<T>;
    } catch {
      throw new SunPayApiError(
        `SunPay returned a non-JSON response for ${method} ${path} (HTTP ${status})`,
        status,
      );
    }

    if (!envelope.is_success || envelope.data === undefined) {
      throw new SunPayApiError(
        `SunPay rejected ${method} ${path}: ${envelope.msg ?? 'no message'} (code ${envelope.code})`,
        status,
        envelope.code,
      );
    }

    return envelope.data;
  }

  private execute(
    method: 'GET' | 'POST',
    url: URL,
    headers: Record<string, string>,
    rawBody: string,
    path: string,
  ): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          method,
          protocol: url.protocol,
          hostname: url.hostname,
          ...(url.port && { port: url.port }),
          path: `${url.pathname}${url.search}`,
          headers,
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );

      req.on('timeout', () => {
        req.destroy();
        // Never assume a timed-out call didn't land — the order may well have
        // been created. Recovery is a status query, never a blind retry.
        reject(
          new SunPayApiError(
            `SunPay ${method} ${path} timed out after ${REQUEST_TIMEOUT_MS}ms — order state is UNKNOWN, query before retrying`,
            0,
          ),
        );
      });
      req.on('error', (error) => {
        this.logger.warn(`SunPay ${method} ${path} failed: ${error.message}`);
        reject(
          new SunPayApiError(
            `SunPay ${method} ${path} failed: ${error.message}`,
            0,
          ),
        );
      });

      if (rawBody) req.write(rawBody);
      req.end();
    });
  }
}
