import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

const logger = new Logger('DatabaseTimezone');

/** The session zone every connection is held to. A `datetime` carries none of its own. */
const UTC_SESSION = "SET time_zone = '+00:00'";

/** mysql2's pool, which the driver holds and does not publish. */
interface MySqlPool {
  on(
    event: 'connection',
    listener: (connection: PinnableConnection) => void,
  ): void;
}

interface PinnableConnection {
  query(sql: string, callback: (error: Error | null) => void): void;
}

/**
 * Holds every connection the pool opens to UTC.
 *
 * `created_at` and `updated_at` are filled by the **server**, in its session
 * zone, and `ON UPDATE` accepts no function but `CURRENT_TIMESTAMP` — so no
 * column default can opt out. A server on a local zone stores local wall-clock
 * in those columns while the application reads every column as UTC.
 */
const pinNewConnections = (dataSource: DataSource): void => {
  const driver = dataSource.driver as {
    pool?: MySqlPool;
    poolCluster?: unknown;
  };

  if (!driver.pool) {
    // A replication config puts a `poolCluster` here, whose per-node pools are
    // unreachable from outside the driver.
    throw new Error(
      driver.poolCluster
        ? 'Replicated database connections cannot be held to UTC from here — set the database server to UTC instead'
        : 'The database driver exposes no connection pool, so its sessions cannot be pinned to UTC',
    );
  }

  driver.pool.on('connection', (connection) =>
    // **Never without a callback**: the driver's query object emits `error`
    // when nothing awaits a result, and an unhandled `error` ends the process.
    connection.query(UTC_SESSION, (error) => {
      if (!error) return;
      logger.error(
        `A database connection could not be held to UTC and will write local-time timestamps: ${error.message}`,
      );
    }),
  );
};

/**
 * Refuses to carry on when the session is not UTC.
 *
 * **One connection for both statements.** Two calls through the data source
 * could land on different ones, proving a connection that was already fine
 * while the driver's own pre-listener connection stayed local.
 */
const assertSessionIsUtc = async (dataSource: DataSource): Promise<void> => {
  const runner = dataSource.createQueryRunner();
  try {
    await runner.connect();
    await runner.query(UTC_SESSION);

    const reading = (await runner.query(
      'SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS offsetSeconds',
    )) as { offsetSeconds: number | string }[];

    const offset = reading[0];
    if (!offset) {
      throw new Error(
        'The database answered no rows when asked how far its session is from UTC',
      );
    }

    // Answered as a bigint, which the driver may hand back as text.
    const offsetSeconds = Number(offset.offsetSeconds);
    if (offsetSeconds !== 0) {
      throw new Error(
        `The database session is ${offsetSeconds} seconds from UTC after being pinned to it, so every timestamp the server writes would be stored in that offset and read back as UTC`,
      );
    }
  } finally {
    await runner.release();
  }
};

/**
 * Holds a data source's sessions to UTC and proves it. **Every data source
 * goes through this**, not only the application's — a migration writes
 * datetimes through an unpinned connection just as readily.
 */
export const holdDatabaseSessionsToUtc = async (
  dataSource: DataSource,
): Promise<DataSource> => {
  pinNewConnections(dataSource);
  await assertSessionIsUtc(dataSource);
  return dataSource;
};
