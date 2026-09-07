import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { holdDatabaseSessionsToUtc } from './database-timezone';

/** The statement every connection has to be given, spelled out rather than imported. */
const UTC_SESSION = "SET time_zone = '+00:00'";

type PinListener = (connection: { query: jest.Mock }) => void;

describe('holdDatabaseSessionsToUtc', () => {
  let listeners: PinListener[];
  let runnerQuery: jest.Mock;
  let release: jest.Mock;
  let error: jest.SpyInstance;

  /** A data source answering the offset check, whose pool records the listener. */
  const dataSourceAnswering = (
    offset: number | string | undefined,
    driver: Record<string, unknown> = {},
  ): DataSource => {
    runnerQuery = jest
      .fn()
      .mockImplementation((sql: string) =>
        sql === UTC_SESSION
          ? Promise.resolve(undefined)
          : Promise.resolve(
              offset === undefined ? [] : [{ offsetSeconds: offset }],
            ),
      );

    return {
      driver: {
        pool: {
          on: (_event: string, listener: PinListener) =>
            listeners.push(listener),
        },
        ...driver,
      },
      createQueryRunner: () => ({
        connect: () => Promise.resolve(),
        query: runnerQuery,
        release,
      }),
    } as unknown as DataSource;
  };

  beforeEach(() => {
    listeners = [];
    release = jest.fn(() => Promise.resolve());
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('holding new connections', () => {
    it('sets the session on every connection the pool opens', async () => {
      await holdDatabaseSessionsToUtc(dataSourceAnswering(0));

      const connection = { query: jest.fn() };
      listeners.forEach((listener) => listener(connection));
      expect(connection.query).toHaveBeenCalledWith(
        UTC_SESSION,
        expect.any(Function),
      );
    });

    it('never sends that statement without a callback', async () => {
      // An unhandled `error` on the driver's query object ends the process.
      await holdDatabaseSessionsToUtc(dataSourceAnswering(0));

      const connection = { query: jest.fn() };
      listeners.forEach((listener) => listener(connection));
      const [, callback] = connection.query.mock.calls[0] as [string, unknown];
      expect(typeof callback).toBe('function');
    });

    it('reports a connection it could not hold, rather than throwing at it', async () => {
      await holdDatabaseSessionsToUtc(dataSourceAnswering(0));

      const connection = {
        query: jest.fn(
          (_sql: string, callback: (error: Error | null) => void) =>
            callback(new Error('connection lost')),
        ),
      };
      expect(() =>
        listeners.forEach((listener) => listener(connection)),
      ).not.toThrow();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('local-time timestamps'),
      );
    });

    it('refuses a driver it cannot reach, rather than doing nothing', async () => {
      // Silently skipping is how a local-time server goes unnoticed.
      const dataSource = { driver: {} } as unknown as DataSource;

      await expect(holdDatabaseSessionsToUtc(dataSource)).rejects.toThrow(
        /no connection pool/,
      );
    });

    it('names replication as the reason when that is what it found', async () => {
      const dataSource = {
        driver: { poolCluster: {} },
      } as unknown as DataSource;

      await expect(holdDatabaseSessionsToUtc(dataSource)).rejects.toThrow(
        /Replicated database connections/,
      );
    });
  });

  describe('proving the session', () => {
    it('pins and checks on one connection, held for both statements', async () => {
      // Two calls could land on different ones, proving the wrong connection.
      await holdDatabaseSessionsToUtc(dataSourceAnswering(0));

      expect(runnerQuery).toHaveBeenNthCalledWith(1, UTC_SESSION);
      expect(runnerQuery).toHaveBeenCalledTimes(2);
      expect(release).toHaveBeenCalled();
    });

    it('passes when the server agrees with UTC', async () => {
      await expect(
        holdDatabaseSessionsToUtc(dataSourceAnswering(0)),
      ).resolves.toBeDefined();
    });

    it('refuses a session still on a local zone', async () => {
      await expect(
        holdDatabaseSessionsToUtc(dataSourceAnswering(12_600)),
      ).rejects.toThrow(/12600 seconds from UTC/);
    });

    it('reads an offset the driver returned as a string', async () => {
      // Answered as a bigint, which the driver may hand back as text.
      await expect(
        holdDatabaseSessionsToUtc(dataSourceAnswering('0')),
      ).resolves.toBeDefined();
    });

    it('refuses a negative offset as readily as a positive one', async () => {
      await expect(
        holdDatabaseSessionsToUtc(dataSourceAnswering(-18_000)),
      ).rejects.toThrow(/-18000 seconds from UTC/);
    });

    it('says so plainly when the database answers no rows at all', async () => {
      await expect(
        holdDatabaseSessionsToUtc(dataSourceAnswering(undefined)),
      ).rejects.toThrow(/no rows/);
    });

    it('releases the connection even when the check refuses', async () => {
      await expect(
        holdDatabaseSessionsToUtc(dataSourceAnswering(3_600)),
      ).rejects.toThrow();
      expect(release).toHaveBeenCalled();
    });
  });
});
