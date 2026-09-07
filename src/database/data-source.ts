import { DataSource } from 'typeorm';
import { holdDatabaseSessionsToUtc } from './database-timezone';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set — the TypeORM CLI requires it in .env',
  );
}

const extension = __filename.endsWith('.ts') ? 'ts' : 'js';
const sourceRoot = extension === 'ts' ? 'src' : 'dist';

const dataSource = new DataSource({
  type: 'mariadb',
  url: databaseUrl,
  charset: 'utf8mb4_unicode_ci',
  timezone: 'Z',
  entities: [`${sourceRoot}/**/*.entity.${extension}`],
  migrations: [`${sourceRoot}/database/migrations/*.${extension}`],
});

/**
 * The CLI calls `initialize()` itself and offers no hook after it, so the UTC
 * hold is wrapped around it here. Without this a migration writing a datetime
 * stores it in the server's own zone while the application reads every column
 * as UTC — the same skew the running application is held against, arriving
 * through the one connection nothing else covers.
 */
const initialize = dataSource.initialize.bind(dataSource);
dataSource.initialize = async (): Promise<DataSource> =>
  holdDatabaseSessionsToUtc(await initialize());

export default dataSource;
