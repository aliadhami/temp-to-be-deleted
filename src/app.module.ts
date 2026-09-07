import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, DataSourceOptions } from 'typeorm';
import { holdDatabaseSessionsToUtc } from './database/database-timezone';
import { ConfigService } from '@nestjs/config';
import { IdentityModule } from './identity/identity.module';
import { PartnersModule } from './partners/partners.module';
import { PaymentsModule } from './payments/payments.module';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { RolesGuard } from './identity/infrastructure/jwt/roles.guard';
import { JwtAuthGuard } from './identity/infrastructure/jwt/jwt-auth.guard';
import { JwtModule } from '@nestjs/jwt';
import { HealthModule } from './health/health.module';
import { ScheduleModule } from '@nestjs/schedule';
import { CardsModule } from './cards/cards.module';
import { SecretsModule } from './secrets/secrets.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      envFilePath:
        process.env.NODE_ENV === 'test'
          ? ['.env.test']
          : ['.env.local', '.env'],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'mariadb',
        url: config.getOrThrow<string>('DATABASE_URL'),
        charset: 'utf8mb4_unicode_ci',
        // Our own values only; the server's `CURRENT_TIMESTAMP` answers to the
        // session zone, which the factory below pins.
        timezone: 'Z',
        autoLoadEntities: true, // entities registered via forFeature are picked up
        synchronize: false, // hard-off, even in dev — migrations only
      }),
      dataSourceFactory: async (options?: DataSourceOptions) => {
        if (!options) {
          throw new Error('TypeORM was given no data source options');
        }
        return holdDatabaseSessionsToUtc(
          await new DataSource(options).initialize(),
        );
      },
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: 60_000,
          limit: config.get<number>('THROTTLE_LIMIT_DEFAULT', 100),
        },
      ],
    }),
    ScheduleModule.forRoot(),
    IdentityModule,
    PartnersModule,
    PaymentsModule,
    HealthModule,
    JwtModule.register({}),
    CardsModule,
    SecretsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
