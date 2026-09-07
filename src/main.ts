import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { applyCardActivationBodyLimit } from './cards/api/card-activation-body';

const bootstrap = async () => {
  // rawBody: exposes req.rawBody alongside the parsed body. Required because
  // gateways that sign their callbacks (SunPay: HMAC over the raw request bytes)
  // cannot be verified from a re-serialized object — JSON.stringify of a parsed
  // body can differ in key order or number formatting and the signature fails.

  const app = await NestFactory.create(AppModule, { rawBody: true });
  // Before anything initialises the application, which is what puts this ahead
  // of the framework's own 100 kb JSON parser. See the helper for why the one
  // route that carries a document needs more and why nothing else gets it.
  applyCardActivationBodyLimit(app);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  const config = app.get(ConfigService);

  if (config.getOrThrow<string>('NODE_ENV') !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Payment Orchestration API')
      .setDescription('Unified Payment Orchestration Dashboard — internal API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
  }

  await app.listen(config.getOrThrow<number>('PORT'));
};

void bootstrap();
