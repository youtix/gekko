import { GekkoError } from '@errors/gekko.error';
import { debug } from '@services/logger';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SQLiteStorage } from './sqlite.storage';

const { mockConfig, mockDb } = vi.hoisted(() => ({
  mockConfig: { getWatch: vi.fn(), getStorage: vi.fn() },
  mockDb: { run: vi.fn(), prepare: vi.fn(), query: vi.fn(), transaction: vi.fn(), close: vi.fn() },
}));

vi.mock('@services/configuration/configuration', () => ({ config: mockConfig }));
vi.mock('@services/logger', () => ({ debug: vi.fn() }));
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

describe('SQLiteStorage', () => {
  const database = 'db/candles.sql';
  const symbol = 'A"B/USDT';
  const interval = { start: 0, end: 0 };
  const candle = { start: 1, open: 2, high: 3, low: 4, close: 5, volume: 6 };
  const tablesQuery = { all: vi.fn(), get: vi.fn() };
  let storage: SQLiteStorage;

  beforeEach(() => {
    mockConfig.getWatch.mockReturnValue({ mode: 'importer' });
    mockConfig.getStorage.mockReturnValue({ type: 'sqlite', database });
    mockDb.prepare.mockReturnValue({ run: vi.fn(() => ({ changes: 1 })), finalize: vi.fn() });
    mockDb.query.mockReturnValue(tablesQuery);
    tablesQuery.get.mockReturnValue({ name: 'CANDLES_BTC_USDT' });
    mockDb.transaction.mockImplementation(fn => fn);
    storage = new SQLiteStorage([]);
  });

  describe('constructor', () => {
    it.each`
      mode          | path          | args
      ${'importer'} | ${database}   | ${[database]}
      ${'realtime'} | ${database}   | ${[database]}
      ${'backtest'} | ${database}   | ${[database, { readonly: true, create: false }]}
      ${'backtest'} | ${':memory:'} | ${[':memory:']}
    `('opens $path in $mode mode with $args', ({ mode, path, args }) => {
      mockConfig.getWatch.mockReturnValue({ mode });
      mockConfig.getStorage.mockReturnValue({ type: 'sqlite', database: path });
      new SQLiteStorage([]);
      expect(Database).toHaveBeenLastCalledWith(...args);
    });

    it.each`
      mode          | path          | calls
      ${'importer'} | ${database}   | ${[['db', { recursive: true }]]}
      ${'realtime'} | ${database}   | ${[['db', { recursive: true }]]}
      ${'backtest'} | ${database}   | ${[]}
      ${'importer'} | ${':memory:'} | ${[]}
    `('creates the parent directories of $path in $mode mode: $calls', ({ mode, path, calls }) => {
      mockConfig.getWatch.mockReturnValue({ mode });
      mockConfig.getStorage.mockReturnValue({ type: 'sqlite', database: path });
      vi.mocked(mkdirSync).mockClear();
      new SQLiteStorage([]);
      expect(vi.mocked(mkdirSync).mock.calls).toEqual(calls);
    });

    it.each`
      storageConfig
      ${undefined}
      ${{ type: 'sqlite', database: '' }}
    `('refuses to open the database of storage $storageConfig', ({ storageConfig }) => {
      mockConfig.getStorage.mockReturnValue(storageConfig);
      expect(() => new SQLiteStorage([])).toThrow(
        new GekkoError('storage', 'No database to open: set storage.database to the path of the SQLite file.'),
      );
    });

    it.each`
      mode          | thrown                                       | message
      ${'importer'} | ${new Error('unable to open database file')} | ${`Cannot open the database ${resolve(database)} (unable to open database file).`}
      ${'importer'} | ${'unable to open database file'}            | ${`Cannot open the database ${resolve(database)} (unable to open database file).`}
      ${'backtest'} | ${new Error('unable to open database file')} | ${`Cannot open the database ${resolve(database)} (unable to open database file). A backtest reads an existing database: check storage.database, or import the candles first.`}
    `('reports a database it cannot open in $mode mode with its resolved path', ({ mode, thrown, message }) => {
      mockConfig.getWatch.mockReturnValue({ mode });
      vi.mocked(Database).mockImplementationOnce(function () {
        throw thrown;
      });
      expect(() => new SQLiteStorage([])).toThrow(new GekkoError('storage', message));
    });

    it('reports a directory it cannot create with the resolved path of the database', () => {
      vi.mocked(mkdirSync).mockImplementationOnce(() => {
        throw new Error('permission denied');
      });
      expect(() => new SQLiteStorage([])).toThrow(
        new GekkoError('storage', `Cannot open the database ${resolve(database)} (permission denied).`),
      );
    });

    // String() threw for it, from the catch meant to report it: the run stopped on a TypeError that named neither SQLite nor the file
    it('reports a database it cannot open for a failure without a prototype, as util.inspect writes it', () => {
      vi.mocked(Database).mockImplementationOnce(function () {
        throw Object.assign(Object.create(null), { code: 'SQLITE_CANTOPEN' });
      });
      expect(() => new SQLiteStorage([])).toThrow(
        new GekkoError('storage', `Cannot open the database ${resolve(database)} ([Object: null prototype] { code: 'SQLITE_CANTOPEN' }).`),
      );
    });

    // main() appends the cause to its report: the error of SQLite, its class, its code and its stack, was dropped
    it('keeps the failure to open the database as the cause', () => {
      const failure = Object.assign(new Error('unable to open database file'), { code: 'SQLITE_CANTOPEN', errno: 14 });
      vi.mocked(Database).mockImplementationOnce(function () {
        throw failure;
      });
      expect(() => new SQLiteStorage([])).toThrow(expect.objectContaining({ cause: failure }));
    });

    it.each`
      mode          | statements
      ${'importer'} | ${['PRAGMA busy_timeout = 5000;', 'PRAGMA journal_mode = WAL;', 'PRAGMA synchronous = NORMAL;', 'CREATE TABLE', 'CREATE TABLE']}
      ${'backtest'} | ${['PRAGMA busy_timeout = 5000;']}
    `('sets up the database in $mode mode with $statements', ({ mode, statements }) => {
      mockConfig.getWatch.mockReturnValue({ mode });
      mockDb.run.mockClear();
      new SQLiteStorage(['BTC/USDT', 'ETH/USDT']);
      expect(runSql().map(sql => (sql.includes('CREATE TABLE') ? 'CREATE TABLE' : sql))).toEqual(statements);
    });

    it('looks up, in backtest mode, the table of every pair', () => {
      mockConfig.getWatch.mockReturnValue({ mode: 'backtest' });
      new SQLiteStorage(['BTC/USDT', 'ETH/USDT']);
      expect(tablesQuery.get.mock.calls).toEqual([
        ['table', 'CANDLES_BTC_USDT'],
        ['table', 'CANDLES_ETH_USDT'],
      ]);
    });

    it('refuses, in backtest mode, the pairs the database has no table for', () => {
      mockConfig.getWatch.mockReturnValue({ mode: 'backtest' });
      tablesQuery.get.mockReturnValueOnce({ name: 'CANDLES_BTC_USDT' }).mockReturnValueOnce(null).mockReturnValueOnce(null);
      expect(() => new SQLiteStorage(['BTC/USDT', 'ETH/USDT', 'SOL/USDT'])).toThrow(
        new GekkoError('storage', `${resolve(database)} holds no candles of ETH/USDT, SOL/USDT: import them first.`),
      );
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
      mockConfig.getWatch.mockReturnValue({ mode });
      storage = new SQLiteStorage([]);
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
      mockConfig.getStorage.mockReturnValue({ type: 'sqlite', database: ':memory:', insertThreshold: 10 });
      storage = new SQLiteStorage([]);
      for (const symbols of buckets) storage.addBucket(new Map(symbols.map((symbol: string) => [symbol, candle])));
      storage.close();
      expect(statement.run.mock.calls).toEqual(inserted);
    });

    it('inserts the buffered candles before checkpointing the WAL', () => {
      const statement = { run: vi.fn(() => ({ changes: 1 })), finalize: vi.fn() };
      mockDb.prepare.mockReturnValue(statement);
      mockConfig.getStorage.mockReturnValue({ type: 'sqlite', database: ':memory:', insertThreshold: 10 });
      storage = new SQLiteStorage([]);
      storage.addBucket(new Map([['BTC/USDT', candle]]));
      storage.close();
      const checkpointCall = mockDb.run.mock.calls.findIndex(([sql]) => sql === 'PRAGMA wal_checkpoint(TRUNCATE);');
      expect(statement.run.mock.invocationCallOrder[0]).toBeLessThan(mockDb.run.mock.invocationCallOrder[checkpointCall]);
    });

    it('does not checkpoint a database opened read-only', () => {
      mockConfig.getWatch.mockReturnValue({ mode: 'backtest' });
      storage = new SQLiteStorage([]);
      storage.close();
      expect(runSql()).not.toContain('PRAGMA wal_checkpoint(TRUNCATE);');
    });

    it('does nothing when the database is already closed', () => {
      storage.close();
      storage.close();
      expect(mockDb.close).toHaveBeenCalledOnce();
    });
  });
});
