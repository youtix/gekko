import type { Watch } from '@gekko/schemas/configuration/configuration.types';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { debug } from '../logger/logger';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SQLiteStorage } from './sqlite.storage';
import { StorageConfig } from './storage.types';

const { mockDb } = vi.hoisted(() => ({
  mockDb: { run: vi.fn(), prepare: vi.fn(), query: vi.fn(), transaction: vi.fn(), close: vi.fn() },
}));

vi.mock('../logger/logger', () => ({ debug: vi.fn() }));
vi.mock('node:fs', () => ({ mkdirSync: vi.fn() }));
vi.mock('bun:sqlite', () => ({
  Database: vi.fn(function () {
    return mockDb;
  }),
}));

/** Runs a call that is expected to throw and swallows the error, so that the test can check what happened around it */
const attempt = (call: () => void) => {
  try {
    call();
  } catch {
    // Expected
  }
};

const runSql = () => mockDb.run.mock.calls.map(([sql]) => sql);

// The sections the storage is built with, as Services hands them: set in beforeEach, changed by a test before it builds its own
let storageConfig: StorageConfig;
let watchMode: Watch['mode'];
/** The storage of `symbols`, built from storageConfig and a watch section of watchMode and those pairs */
const createStorage = (symbols: TradingPair[] = []) =>
  new SQLiteStorage(storageConfig, { mode: watchMode, pairs: symbols.map(symbol => ({ symbol })) });

describe('SQLiteStorage', () => {
  const database = 'db/candles.sql';
  const symbol = 'A"B/USDT';
  const interval = { start: 0, end: 0 };
  const candle = { start: 1, open: 2, high: 3, low: 4, close: 5, volume: 6 };
  const tablesQuery = { all: vi.fn(), get: vi.fn() };
  let storage: SQLiteStorage;

  beforeEach(() => {
    watchMode = 'importer';
    storageConfig = { type: 'sqlite', database };
    mockDb.prepare.mockReturnValue({ run: vi.fn(() => ({ changes: 1 })), finalize: vi.fn() });
    mockDb.query.mockReturnValue(tablesQuery);
    tablesQuery.get.mockReturnValue({ name: 'CANDLES_BTC_USDT' });
    mockDb.transaction.mockImplementation(fn => fn);
    storage = createStorage();
  });

  describe('constructor', () => {
    it.each`
      mode          | path          | args
      ${'importer'} | ${database}   | ${[database]}
      ${'realtime'} | ${database}   | ${[database]}
      ${'backtest'} | ${database}   | ${[database, { readonly: true, create: false }]}
      ${'backtest'} | ${':memory:'} | ${[':memory:']}
    `('opens $path in $mode mode with $args', ({ mode, path, args }) => {
      watchMode = mode;
      storageConfig = { type: 'sqlite', database: path };
      createStorage();
      expect(Database).toHaveBeenLastCalledWith(...args);
    });

    it.each`
      mode          | path          | calls
      ${'importer'} | ${database}   | ${[['db', { recursive: true }]]}
      ${'realtime'} | ${database}   | ${[['db', { recursive: true }]]}
      ${'backtest'} | ${database}   | ${[]}
      ${'importer'} | ${':memory:'} | ${[]}
    `('creates the parent directories of $path in $mode mode: $calls', ({ mode, path, calls }) => {
      watchMode = mode;
      storageConfig = { type: 'sqlite', database: path };
      vi.mocked(mkdirSync).mockClear();
      createStorage();
      expect(vi.mocked(mkdirSync).mock.calls).toEqual(calls);
    });

    // The schema refuses an empty path, which Bun would open as an in-memory database: the candles would be lost on exit. A storage
    // section left out never reaches the storage: Services refuses it first.
    it('refuses to open the database of a storage section without a path', () => {
      storageConfig = { type: 'sqlite', database: '' };
      expect(() => createStorage()).toThrow(
        new GekkoError('storage', 'No database to open: set storage.database to the path of the SQLite file.'),
      );
    });

    it.each`
      mode          | thrown                                       | message
      ${'importer'} | ${new Error('unable to open database file')} | ${`Cannot open the database ${resolve(database)} (unable to open database file).`}
      ${'importer'} | ${'unable to open database file'}            | ${`Cannot open the database ${resolve(database)} (unable to open database file).`}
      ${'backtest'} | ${new Error('unable to open database file')} | ${`Cannot open the database ${resolve(database)} (unable to open database file). A backtest reads an existing database: check storage.database, or import the candles first.`}
    `('reports a database it cannot open in $mode mode with its resolved path', ({ mode, thrown, message }) => {
      watchMode = mode;
      vi.mocked(Database).mockImplementationOnce(function () {
        throw thrown;
      });
      expect(() => createStorage()).toThrow(new GekkoError('storage', message));
    });

    it('reports a directory it cannot create with the resolved path of the database', () => {
      vi.mocked(mkdirSync).mockImplementationOnce(() => {
        throw new Error('permission denied');
      });
      expect(() => createStorage()).toThrow(
        new GekkoError('storage', `Cannot open the database ${resolve(database)} (permission denied).`),
      );
    });

    // String() threw for it, from the catch meant to report it: the run stopped on a TypeError that named neither SQLite nor the file
    it('reports a database it cannot open for a failure without a prototype, as util.inspect writes it', () => {
      vi.mocked(Database).mockImplementationOnce(function () {
        throw Object.assign(Object.create(null), { code: 'SQLITE_CANTOPEN' });
      });
      expect(() => createStorage()).toThrow(
        new GekkoError('storage', `Cannot open the database ${resolve(database)} ([Object: null prototype] { code: 'SQLITE_CANTOPEN' }).`),
      );
    });

    // main() appends the cause to its report: the error of SQLite, its class, its code and its stack, was dropped
    it('keeps the failure to open the database as the cause', () => {
      const failure = Object.assign(new Error('unable to open database file'), { code: 'SQLITE_CANTOPEN', errno: 14 });
      vi.mocked(Database).mockImplementationOnce(function () {
        throw failure;
      });
      expect(() => createStorage()).toThrow(expect.objectContaining({ cause: failure }));
    });

    // The read of the schema comes first, under the busy timeout: it is where a file that is not a database fails
    it.each`
      mode          | statements
      ${'importer'} | ${['PRAGMA busy_timeout = 5000;', 'SELECT count(*) FROM sqlite_master;', 'PRAGMA journal_mode = WAL;', 'PRAGMA synchronous = NORMAL;', 'CREATE TABLE', 'CREATE TABLE']}
      ${'backtest'} | ${['PRAGMA busy_timeout = 5000;', 'SELECT count(*) FROM sqlite_master;']}
    `('sets up the database in $mode mode with $statements', ({ mode, statements }) => {
      watchMode = mode;
      mockDb.run.mockClear();
      createStorage(['BTC/USDT', 'ETH/USDT']);
      expect(runSql().map(sql => (sql.includes('CREATE TABLE') ? 'CREATE TABLE' : sql))).toEqual(statements);
    });

    // bun:sqlite opens such a file without a word, and fails at the first statement that reads it: that was the first query of a
    // backtest, or the switch to WAL of the other modes, which threw SQLite's error and its stack, without the path or the hint
    describe('on a file that is not a database, a CSV or a truncated copy', () => {
      const notADatabase = Object.assign(new Error('file is not a database'), { name: 'SQLiteError', code: 'SQLITE_NOTADB' });

      beforeEach(() => {
        // Every statement that reads the file throws, as SQLite does: the busy timeout reads nothing
        mockDb.run.mockImplementation((sql: string) => {
          if (sql !== 'PRAGMA busy_timeout = 5000;') throw notADatabase;
        });
        tablesQuery.get.mockImplementation(() => {
          throw notADatabase;
        });
      });

      it.each`
        mode          | message
        ${'importer'} | ${`Cannot open the database ${resolve(database)} (file is not a database).`}
        ${'realtime'} | ${`Cannot open the database ${resolve(database)} (file is not a database).`}
        ${'backtest'} | ${`Cannot open the database ${resolve(database)} (file is not a database). A backtest reads an existing database: check storage.database, or import the candles first.`}
      `('reports it in $mode mode with its resolved path', ({ mode, message }) => {
        watchMode = mode;
        expect(() => createStorage(['BTC/USDT'])).toThrow(new GekkoError('storage', message));
      });

      it('keeps the failure of its first read as the cause', () => {
        expect(() => createStorage(['BTC/USDT'])).toThrow(expect.objectContaining({ cause: notADatabase }));
      });

      it('closes the connection it opened', () => {
        attempt(() => createStorage(['BTC/USDT']));
        expect(mockDb.close).toHaveBeenCalledOnce();
      });
    });

    it('looks up, in backtest mode, the table of every pair', () => {
      watchMode = 'backtest';
      createStorage(['BTC/USDT', 'ETH/USDT']);
      expect(tablesQuery.get.mock.calls).toEqual([
        ['table', 'CANDLES_BTC_USDT'],
        ['table', 'CANDLES_ETH_USDT'],
      ]);
    });

    it('refuses, in backtest mode, the pairs the database has no table for', () => {
      watchMode = 'backtest';
      tablesQuery.get.mockReturnValueOnce({ name: 'CANDLES_BTC_USDT' }).mockReturnValueOnce(null).mockReturnValueOnce(null);
      expect(() => createStorage(['BTC/USDT', 'ETH/USDT', 'SOL/USDT'])).toThrow(
        new GekkoError('storage', `${resolve(database)} holds no candles of ETH/USDT, SOL/USDT: import them first.`),
      );
    });

    // Once the database is open, a failure of the rest of its setup left the connection open: the storage never reached the
    // run's services, whose closeStorage() closes the one they created
    describe('when its setup fails once the database is open', () => {
      const locked = Object.assign(new Error('database is locked'), { name: 'SQLiteError', code: 'SQLITE_BUSY' });
      /** Every statement holding `statement` throws `locked`, the others run */
      const failOn = (statement: string) =>
        mockDb.run.mockImplementation((sql: string) => {
          if (sql.includes(statement)) throw locked;
        });

      it.each`
        mode          | failure                      | fail
        ${'backtest'} | ${'a pair without a table'}  | ${() => tablesQuery.get.mockReturnValue(null)}
        ${'importer'} | ${'the switch to WAL'}       | ${() => failOn('PRAGMA journal_mode = WAL;')}
        ${'realtime'} | ${'the creation of a table'} | ${() => failOn('CREATE TABLE')}
      `('closes the connection it opened in $mode mode, on $failure', ({ mode, fail }) => {
        watchMode = mode;
        fail();
        attempt(() => createStorage(['BTC/USDT']));
        expect(mockDb.close).toHaveBeenCalledOnce();
      });

      it('rethrows the failure as it was thrown', () => {
        failOn('PRAGMA journal_mode = WAL;');
        let thrown: unknown;
        try {
          createStorage(['BTC/USDT']);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBe(locked);
      });
    });
  });

  /** A statement is only prepared for a candle to write */
  const insertCandleOfSymbol = () => {
    storage.addBucket(new Map([[symbol, candle]]));
    storage.insertCandles(symbol);
  };

  it.each`
    method                   | call                                             | sqlRunBy
    ${'createTable'}         | ${() => storage.createTable(symbol)}             | ${mockDb.run}
    ${'insertCandles'}       | ${insertCandleOfSymbol}                          | ${mockDb.prepare}
    ${'getCandleDateranges'} | ${() => storage.getCandleDateranges(symbol)}     | ${mockDb.query}
    ${'getCandles'}          | ${() => storage.getCandles(symbol, interval)}    | ${mockDb.query}
    ${'checkInterval'}       | ${() => storage.checkInterval(symbol, interval)} | ${mockDb.query}
  `('quotes the table name in the SQL of $method, doubling its quotes', ({ call, sqlRunBy }) => {
    call();
    expect(sqlRunBy.mock.lastCall?.[0]).toContain('"CANDLES_A""B_USDT"');
  });

  it.each`
    method             | call
    ${'getCandles'}    | ${() => storage.getCandles(symbol, interval)}
    ${'checkInterval'} | ${() => storage.checkInterval(symbol, interval)}
  `('reads only the rows that start a minute in $method, like the other one', ({ call }) => {
    call();
    expect(mockDb.query.mock.lastCall?.[0]).toContain('WHERE start BETWEEN $start AND $end AND start % 60000 = 0');
  });

  it('inserts the buffered candles of the pair, skipping the buckets without it', () => {
    const statement = { run: vi.fn(() => ({ changes: 1 })), finalize: vi.fn() };
    mockDb.prepare.mockReturnValue(statement);
    storage.addBucket(new Map([['BTC/USDT', { start: 1, open: 2, high: 3, low: 4, close: 5, volume: 6 }]]));
    storage.addBucket(new Map([['ETH/USDT', { start: 1, open: 2, high: 3, low: 4, close: 5, volume: 6 }]]));
    storage.insertCandles('BTC/USDT');
    expect(statement.run.mock.calls).toEqual([[1, 2, 3, 4, 5, 6]]);
  });

  describe('insertCandles', () => {
    const statement = { run: vi.fn(() => ({ changes: 1 })), finalize: vi.fn() };
    const madeUp = { start: 2, open: 5, high: 5, low: 5, close: 5, volume: 0, synthetic: true as const };
    const upsert =
      'INSERT INTO "CANDLES_BTC_USDT" (start, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(start) DO UPDATE SET open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, volume = excluded.volume';
    const storedMadeUp =
      ' WHERE "CANDLES_BTC_USDT".volume = 0 AND "CANDLES_BTC_USDT".open = "CANDLES_BTC_USDT".high AND "CANDLES_BTC_USDT".high = "CANDLES_BTC_USDT".low AND "CANDLES_BTC_USDT".low = "CANDLES_BTC_USDT".close';
    const storedMadeUpByTraded = `${storedMadeUp} AND excluded.volume > 0`;
    /** Each prepare returns a statement of its own, so that a test can tell them apart */
    const prepareStatementsApart = () =>
      mockDb.prepare.mockImplementation(() => ({ run: vi.fn(() => ({ changes: 1 })), finalize: vi.fn() }));
    const preparedStatements = () => mockDb.prepare.mock.results.map(({ value }) => value);

    beforeEach(() => {
      mockDb.prepare.mockReturnValue(statement);
      storage.addBucket(new Map([['BTC/USDT', { start: 1, open: 2, high: 3, low: 4, close: 5, volume: 6 }]]));
    });

    it.each`
      mode          | kind         | written   | replaced                                                      | condition
      ${'importer'} | ${'real'}    | ${candle} | ${'any stored minute'}                                        | ${''}
      ${'importer'} | ${'made-up'} | ${madeUp} | ${'only a stored minute flat without volume'}                 | ${storedMadeUp}
      ${'realtime'} | ${'real'}    | ${candle} | ${'only a stored minute flat without volume, when it traded'} | ${storedMadeUpByTraded}
      ${'realtime'} | ${'made-up'} | ${madeUp} | ${'only a stored minute flat without volume, when it traded'} | ${storedMadeUpByTraded}
    `('writes a $kind candle in $mode mode replacing $replaced', ({ mode, written, condition }) => {
      watchMode = mode;
      storage = createStorage();
      storage.addBucket(new Map([['BTC/USDT', written]]));
      storage.insertCandles('BTC/USDT');
      expect(mockDb.prepare.mock.lastCall?.[0].replace(/\s+/g, ' ').trim()).toBe(`${upsert}${condition}`);
    });

    it('writes each candle of an import with the statement of its kind, prepared once', () => {
      prepareStatementsApart();
      // After the real candle of minute 1: made up, real, made up
      for (const written of [madeUp, { ...candle, start: 3 }, { ...madeUp, start: 4 }]) {
        storage.addBucket(new Map([['BTC/USDT', written]]));
      }
      storage.insertCandles('BTC/USDT');
      expect(preparedStatements().map(({ run }) => run.mock.calls.map(([start]: number[]) => start))).toEqual([
        [1, 3],
        [2, 4],
      ]);
    });

    it('finalizes every statement it prepared, once', () => {
      prepareStatementsApart();
      storage.addBucket(new Map([['BTC/USDT', madeUp]]));
      storage.insertCandles('BTC/USDT');
      expect(preparedStatements().map(({ finalize }) => finalize.mock.calls.length)).toEqual([1, 1]);
    });

    it('finalizes the statements it prepared before an insert failed', () => {
      mockDb.prepare.mockImplementationOnce(() => ({ run: vi.fn(() => ({ changes: 1 })), finalize: vi.fn() }));
      mockDb.prepare.mockImplementationOnce(() => ({
        run: vi.fn(() => {
          throw new Error('disk full');
        }),
        finalize: vi.fn(),
      }));
      storage.addBucket(new Map([['BTC/USDT', madeUp]]));
      attempt(() => storage.insertCandles('BTC/USDT'));
      expect(preparedStatements().map(({ finalize }) => finalize.mock.calls.length)).toEqual([1, 1]);
    });

    it.each`
      changes   | message
      ${[1, 1]} | ${'2 BTC/USDT candles written in database'}
      ${[1, 0]} | ${'1 BTC/USDT candle written in database'}
      ${[0, 0]} | ${'0 BTC/USDT candles written in database'}
    `('logs the rows actually written, $changes, not the candles it tried', ({ changes, message }) => {
      for (const count of changes) statement.run.mockReturnValueOnce({ changes: count });
      storage.addBucket(new Map([['BTC/USDT', { start: 2, open: 2, high: 3, low: 4, close: 5, volume: 6 }]]));
      storage.insertCandles('BTC/USDT');
      expect(debug).toHaveBeenLastCalledWith('storage', message);
    });

    it('finalizes the insert statement', () => {
      storage.insertCandles('BTC/USDT');
      expect(statement.finalize).toHaveBeenCalledOnce();
    });

    it('rethrows a failed insert', () => {
      statement.run.mockImplementation(() => {
        throw new Error('disk full');
      });
      expect(() => storage.insertCandles('BTC/USDT')).toThrow('disk full');
    });

    it('finalizes the insert statement when an insert fails', () => {
      statement.run.mockImplementation(() => {
        throw new Error('disk full');
      });
      attempt(() => storage.insertCandles('BTC/USDT'));
      expect(statement.finalize).toHaveBeenCalledOnce();
    });
  });

  describe('close', () => {
    it('closes the database', () => {
      storage.close();
      expect(mockDb.close).toHaveBeenCalledWith(false);
    });

    it('checkpoints the WAL into the database file before closing', () => {
      storage.close();
      const checkpointCall = mockDb.run.mock.calls.findIndex(([sql]) => sql === 'PRAGMA wal_checkpoint(TRUNCATE);');
      expect(mockDb.run.mock.invocationCallOrder[checkpointCall]).toBeLessThan(mockDb.close.mock.invocationCallOrder[0]);
    });

    it('still closes the database when the checkpoint fails', () => {
      mockDb.run.mockImplementation(sql => {
        if (sql.startsWith('PRAGMA wal_checkpoint')) throw new Error('database is locked');
      });
      attempt(() => storage.close());
      expect(mockDb.close).toHaveBeenCalledOnce();
    });

    it.each`
      scenario              | buckets                                     | inserted
      ${'an empty buffer'}  | ${[]}                                       | ${[]}
      ${'buffered buckets'} | ${[['BTC/USDT'], ['BTC/USDT', 'ETH/USDT']]} | ${[[1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6]]}
    `('inserts the candles of $scenario before closing', ({ buckets, inserted }) => {
      const statement = { run: vi.fn(() => ({ changes: 1 })), finalize: vi.fn() };
      mockDb.prepare.mockReturnValue(statement);
      storageConfig = { type: 'sqlite', database: ':memory:', insertThreshold: 10 };
      storage = createStorage();
      for (const symbols of buckets) storage.addBucket(new Map(symbols.map((symbol: string) => [symbol, candle])));
      storage.close();
      expect(statement.run.mock.calls).toEqual(inserted);
    });

    it('inserts the buffered candles before checkpointing the WAL', () => {
      const statement = { run: vi.fn(() => ({ changes: 1 })), finalize: vi.fn() };
      mockDb.prepare.mockReturnValue(statement);
      storageConfig = { type: 'sqlite', database: ':memory:', insertThreshold: 10 };
      storage = createStorage();
      storage.addBucket(new Map([['BTC/USDT', candle]]));
      storage.close();
      const checkpointCall = mockDb.run.mock.calls.findIndex(([sql]) => sql === 'PRAGMA wal_checkpoint(TRUNCATE);');
      expect(statement.run.mock.invocationCallOrder[0]).toBeLessThan(mockDb.run.mock.invocationCallOrder[checkpointCall]);
    });

    it('does not checkpoint a database opened read-only', () => {
      watchMode = 'backtest';
      storage = createStorage();
      storage.close();
      expect(runSql()).not.toContain('PRAGMA wal_checkpoint(TRUNCATE);');
    });

    it('does nothing when the database is already closed', () => {
      storage.close();
      storage.close();
      expect(mockDb.close).toHaveBeenCalledOnce();
    });

    // The candles are in the WAL, which the next connection reads: nothing to count as unwritten
    it('rethrows a failed checkpoint as SQLite reports it', () => {
      mockDb.run.mockImplementation(sql => {
        if (sql.startsWith('PRAGMA wal_checkpoint')) throw new Error('disk I/O error');
      });
      expect(() => storage.close()).toThrow(new Error('disk I/O error'));
    });

    // SQLite's error alone, which the end of an import logged as a hidden warning: it exited with code 0, its last minutes missing
    describe('when the insert of the buffered candles fails', () => {
      const lockError = Object.assign(new Error('database is locked'), { name: 'SQLiteError', code: 'SQLITE_BUSY' });
      const failingStatement = () => ({
        run: vi.fn(() => {
          throw lockError;
        }),
        finalize: vi.fn(),
      });
      /** Buffers a bucket per entry, one minute after the other from 2024-01-01T00:00Z, holding the candles of its pairs */
      const bufferBuckets = (buckets: TradingPair[][]) =>
        buckets.forEach((symbols, index) =>
          storage.addBucket(new Map(symbols.map(symbol => [symbol, { ...candle, start: Date.UTC(2024, 0, 1, 0, index) }]))),
        );

      beforeEach(() => {
        mockDb.prepare.mockImplementation(failingStatement);
      });

      it.each`
        scenario                                                                   | buckets                                                                           | written         | unwritten
        ${'every pair, when the first insert fails'}                               | ${[['BTC/USDT', 'ETH/USDT'], ['BTC/USDT', 'ETH/USDT'], ['BTC/USDT', 'ETH/USDT']]} | ${[]}           | ${'the minutes from 2024-01-01T00:00:00.000Z to 2024-01-01T00:02:00.000Z were not written, 3 of BTC/USDT, 3 of ETH/USDT'}
        ${'only the pairs left, when an insert fails after another one succeeded'} | ${[['BTC/USDT'], ['BTC/USDT', 'ETH/USDT'], ['BTC/USDT', 'ETH/USDT']]}             | ${['BTC/USDT']} | ${'the minutes from 2024-01-01T00:01:00.000Z to 2024-01-01T00:02:00.000Z were not written, 2 of ETH/USDT'}
      `('reports the buffered minutes it could not write, per pair, and their range: $scenario', ({ buckets, written, unwritten }) => {
        mockDb.prepare.mockImplementation((sql: string) =>
          written.some((symbol: string) => sql.includes(`"CANDLES_${symbol.replace('/', '_')}"`))
            ? { run: vi.fn(() => ({ changes: 1 })), finalize: vi.fn() }
            : failingStatement(),
        );
        bufferBuckets(buckets);
        expect(() => storage.close()).toThrow(
          new GekkoError(
            'storage',
            `Could not write the buffered candles into ${resolve(database)} (database is locked): ${unwritten}. An import of that range writes them.`,
          ),
        );
      });

      it('keeps the failure of the insert as the cause', () => {
        bufferBuckets([['BTC/USDT']]);
        expect(() => storage.close()).toThrow(expect.objectContaining({ cause: lockError }));
      });

      it('still closes the database', () => {
        bufferBuckets([['BTC/USDT']]);
        attempt(() => storage.close());
        expect(mockDb.close).toHaveBeenCalledOnce();
      });

      // The connection is closed: main() closes the storage again on its way out, where a second report would throw past the failure
      it('does nothing on a second close', () => {
        bufferBuckets([['BTC/USDT']]);
        attempt(() => storage.close());
        expect(() => storage.close()).not.toThrow();
      });
    });
  });
});
