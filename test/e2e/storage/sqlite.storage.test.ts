import type { SQLiteStorage as ISQLiteStorage } from '@services/storage/sqlite.storage';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IN_MEMORY = { type: 'sqlite', database: ':memory:', insertThreshold: 1 };
// Read by the configuration mock on each call: the tests on database files and on a minute inserted twice change them, then
// restore them. The storage reads the mode when it is built: it decides what a written candle replaces among the stored ones.
let storageConfig: Record<string, unknown> = IN_MEMORY;
let mode = 'backtest';

// Mocks for configuration must be defined before imports that evaluate them
mock.module('@services/configuration/configuration', () => ({
  config: {
    getStorage: () => storageConfig,
    getWatch: () => ({ mode }),
  },
}));

const MINUTE = 60_000;
const start = 1_700_000_040_000;
const end = start + 3 * MINUTE;
// Minute 2 is missing: one gap, so two date ranges
const candles = [0, 1, 3].map(minute => ({ start: start + minute * MINUTE, open: 10, high: 12, low: 9, close: 11, volume: minute + 1 }));

describe('SQLiteStorage', () => {
  let SQLiteStorage: typeof ISQLiteStorage;

  beforeAll(async () => {
    ({ SQLiteStorage } = await import('@services/storage/sqlite.storage'));
  });

  describe('table names', () => {
    describe.each([
      ['BTC/USDT', 'CANDLES_BTC_USDT'],
      ['1INCH/USDT', 'CANDLES_1INCH_USDT'],
      ['C98/USDT', 'CANDLES_C98_USDT'],
      ['1000SATS/USDT', 'CANDLES_1000SATS_USDT'],
      ['BTC/USD1', 'CANDLES_BTC_USD1'],
      ['FLX-CRCL/USDC:USDC', 'CANDLES_FLX-CRCL_USDC:USDC'],
      ['A"B/USDT', 'CANDLES_A"B_USDT'],
    ] as const)('%s', (symbol, table) => {
      let storage: ISQLiteStorage;

      beforeEach(() => {
        storage = new SQLiteStorage([symbol]);
        candles.forEach(candle => storage.addBucket(new Map([[symbol, candle]])));
      });

      afterEach(() => {
        storage.close();
      });

      it(`creates the table ${table}`, () => {
        expect(storage.db.query('SELECT name FROM sqlite_master WHERE name LIKE ?').all('CANDLES%')).toEqual([{ name: table }]);
      });

      it('reads back the inserted candles', () => {
        expect(storage.getCandles(symbol, { start, end })).toEqual(candles.map((candle, index) => ({ id: index + 1, ...candle })));
      });

      it('lists the date ranges of the candles', () => {
        expect(storage.getCandleDateranges(symbol)).toEqual([
          { daterange_start: start, daterange_end: start + MINUTE },
          { daterange_start: end, daterange_end: end },
        ]);
      });

      it('counts the missing candles of the interval', () => {
        expect(storage.checkInterval(symbol, { start, end })).toEqual({ missingCandleCount: 1 });
      });
    });

    it('reads a table created by the former, unquoted statement', () => {
      const storage = new SQLiteStorage([]);
      storage.db.run(
        'CREATE TABLE IF NOT EXISTS CANDLES_BTC_USDT (id INTEGER PRIMARY KEY AUTOINCREMENT, start INTEGER UNIQUE, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL)',
      );
      storage.db.run('INSERT INTO CANDLES_BTC_USDT VALUES (NULL, ?, 10, 12, 9, 11, 1)', [start]);
      storage.createTable('btc/usdt');
      expect(storage.getCandles('btc/usdt', { start, end })).toEqual([{ id: 1, ...candles[0] }]);
      storage.close();
    });
  });

  describe('a minute inserted twice', () => {
    const symbol = 'BTC/USDT';
    const flat = (price: number, volume: number) => ({ start, open: price, high: price, low: price, close: price, volume });
    const real = (price: number, volume: number) => ({ start, open: price, high: price + 2, low: price - 1, close: price + 1, volume });
    // A candle FillCandleGapStream made up, flagged synthetic: the database does not keep the flag, it reads back as flat(price, 0)
    const madeUp = (price: number) => ({ ...flat(price, 0), synthetic: true as const });

    afterEach(() => {
      mode = 'backtest';
    });

    // Every row checks that the minute keeps its row and its id
    it.each([
      // Any run but an import only replaces a stored made-up candle (flat, no volume), with one that traded
      ['realtime', 'replaces a made-up candle (flat, no volume) with a real one', flat(10, 0), real(20, 42), real(20, 42)],
      ['realtime', 'replaces a made-up candle with a flat candle that traded', flat(10, 0), flat(20, 5), flat(20, 5)],
      ['realtime', 'keeps a real candle over another real one', real(10, 5), real(20, 42), real(10, 5)],
      ['realtime', 'keeps a candle without volume that is not flat', real(10, 0), real(20, 42), real(10, 0)],
      ['realtime', 'keeps a flat candle that traded', flat(10, 5), real(20, 42), flat(10, 5)],
      ['realtime', 'keeps a made-up candle over another made-up one', flat(10, 0), madeUp(20), flat(10, 0)],
      ['realtime', 'keeps a made-up candle over a real minute without trades (flat, no volume)', flat(10, 0), flat(20, 0), flat(10, 0)],
      ['realtime', 'keeps a real candle, such as an imported one, over a made-up one', real(10, 5), madeUp(11), real(10, 5)],
      // An import has the last word on the exchange's candles: it reads the exchange's history
      ['importer', 'replaces a made-up candle, such as one of a realtime run, with a real one', flat(10, 0), real(20, 42), real(20, 42)],
      ['importer', 'replaces a real candle with another real one', real(10, 5), real(20, 42), real(20, 42)],
      ['importer', 'replaces a real candle with a real minute without trades (flat, no volume)', real(10, 5), flat(11, 0), flat(11, 0)],
      // A candle the import made up, for a minute missing from the exchange's history, only replaces a stored made-up one
      ['importer', 'keeps a real candle over a candle it made up', real(10, 5), madeUp(11), real(10, 5)],
      ['importer', 'replaces a made-up candle with a candle it made up', flat(10, 0), madeUp(20), flat(20, 0)],
    ])('in %s mode, %s', (runMode, _scenario, stored, inserted, expected) => {
      mode = runMode;
      const storage = new SQLiteStorage([symbol]);
      storage.addBucket(new Map([[symbol, stored]]));
      storage.addBucket(new Map([[symbol, inserted]]));
      const candles = storage.getCandles(symbol, { start, end: start });
      storage.close();
      expect(candles).toEqual([{ id: 1, ...expected }]);
    });
  });

  describe('minutes of an interval', () => {
    const symbol = 'BTC/USDT';
    const offGrid = { ...candles[0], start: start + 2 * MINUTE + 1 }; // Inside the missing minute, but not its start
    let storage: ISQLiteStorage;

    beforeEach(() => {
      storage = new SQLiteStorage([symbol]);
      [...candles, offGrid].forEach(candle => storage.addBucket(new Map([[symbol, candle]])));
    });

    afterEach(() => {
      storage.close();
    });

    it.each([
      ['every minute stored', start, start + MINUTE, 0],
      ['one minute missing, the off-grid row not counted', start, end, 1],
      ['the missing minute alone', start + 2 * MINUTE, start + 2 * MINUTE, 1],
      ['two minutes after the last candle', start, end + 2 * MINUTE, 3],
      ['no candle at all', end + MINUTE, end + 10 * MINUTE, 10],
    ])('counts the missing candles with %s', (_scenario, from, to, missingCandleCount) => {
      expect(storage.checkInterval(symbol, { start: from, end: to })).toEqual({ missingCandleCount });
    });

    it('reads only the candles that start a minute', () => {
      expect(storage.getCandles(symbol, { start, end }).map(candle => candle.start)).toEqual(candles.map(candle => candle.start));
    });
  });

  describe('database file', () => {
    let directory: string;
    let database: string;
    const symbol = 'BTC/USDT';
    // An import of the candles whose storage is left open: they wait in its buffer, which it writes as it closes
    const startImport = (path: string) => {
      storageConfig = { type: 'sqlite', database: path, insertThreshold: 1000 };
      mode = 'importer';
      const storage = new SQLiteStorage([symbol]);
      candles.forEach(candle => storage.addBucket(new Map([[symbol, candle]])));
      return storage;
    };
    const writeCandles = (path: string) => startImport(path).close();
    const countRows = (path: string) => {
      const reader = new Database(path, { readonly: true });
      const { count } = reader.query('SELECT COUNT(*) AS count FROM CANDLES_BTC_USDT').get() as { count: number };
      reader.close();
      return count;
    };
    // A file that does not exist yet, in a directory that exists. Under the default path's missing directories no open mode could
    // create one, so a backtest that created its database passed the tests meant to refuse it.
    const missingDatabase = () => join(directory, `${crypto.randomUUID()}.sql`);
    // bun:sqlite opens a file that is not a database without a word: it failed at the first statement that read it, with SQLite's own
    // error and its stack, and no path
    const writeText = (path: string) => writeFileSync(path, 'start,open,high,low,close,volume\n1700000040000,10,12,9,11,1\n');
    const writeCutDatabase = (path: string) => {
      writeCandles(path);
      truncateSync(path, 50); // Within the 100 bytes of its header, which PRAGMA schema_version still reads
    };
    const BACKTEST_HINT = ' A backtest reads an existing database: check storage.database, or import the candles first.';

    beforeAll(() => {
      directory = mkdtempSync(join(tmpdir(), 'gekko-storage-e2e-'));
    });

    beforeEach(() => {
      database = join(directory, `${crypto.randomUUID()}/nested/candles.sql`);
    });

    afterEach(() => {
      storageConfig = IN_MEMORY;
      mode = 'backtest';
    });

    afterAll(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    it('creates the missing directories of a database it writes', () => {
      writeCandles(database);
      expect(existsSync(database)).toBe(true);
    });

    it('leaves no WAL or shared-memory file behind when it closes the only connection to the file', () => {
      writeCandles(database);
      expect([existsSync(`${database}-wal`), existsSync(`${database}-shm`)]).toEqual([false, false]);
    });

    it('writes every candle into the database file itself when it closes the only connection to it, as a copy of the file shows', () => {
      writeCandles(database);
      const copy = `${database}.copy`;
      copyFileSync(database, copy);
      expect(countRows(copy)).toBe(candles.length);
    });

    it('writes every candle into the database file itself while another connection keeps the file open, as a copy of the file shows', () => {
      const storage = startImport(database);
      // A database browser, or a backtest reading the file. SQLite moves the WAL into the database file by itself only when the last
      // connection to it closes: with another one open, the storage's own checkpoint is what puts the candles in the file.
      const other = new Database(database, { readonly: true });
      try {
        other.query('SELECT COUNT(*) FROM sqlite_master').get(); // A connection holds the file from its first read, not from its opening
        storage.close();
        const copy = `${database}.copy`;
        copyFileSync(database, copy);
        expect(countRows(copy)).toBe(candles.length);
      } finally {
        other.close();
      }
    });

    it('reads in backtest mode the candles an import wrote', () => {
      writeCandles(database);
      storageConfig = { type: 'sqlite', database };
      mode = 'backtest';
      const storage = new SQLiteStorage([symbol]);
      const read = storage.getCandles(symbol, { start, end });
      storage.close();
      expect(read).toHaveLength(candles.length);
    });

    it('opens the database read-only in backtest mode', () => {
      writeCandles(database);
      storageConfig = { type: 'sqlite', database };
      mode = 'backtest';
      const storage = new SQLiteStorage([symbol]);
      const write = () => storage.db.run('DELETE FROM CANDLES_BTC_USDT');
      try {
        expect(write).toThrow('attempt to write a readonly database');
      } finally {
        storage.close();
      }
    });

    it('refuses a database that does not exist in backtest mode, naming its path', () => {
      const missing = missingDatabase();
      storageConfig = { type: 'sqlite', database: missing };
      mode = 'backtest';
      expect(() => new SQLiteStorage([symbol])).toThrow(`[STORAGE] Cannot open the database ${missing} (unable to open database file).`);
    });

    it('does not create the database it refused in backtest mode', () => {
      const missing = missingDatabase();
      storageConfig = { type: 'sqlite', database: missing };
      mode = 'backtest';
      try {
        new SQLiteStorage([symbol]);
      } catch {
        // Expected
      }
      expect(existsSync(missing)).toBe(false);
    });

    it('refuses in backtest mode a pair the database has no table for', () => {
      writeCandles(database);
      storageConfig = { type: 'sqlite', database };
      mode = 'backtest';
      expect(() => new SQLiteStorage([symbol, 'ETH/USDT'])).toThrow(
        `[STORAGE] ${database} holds no candles of ETH/USDT: import them first.`,
      );
    });

    it.each([
      ['backtest', 'a text file', writeText, 'file is not a database', BACKTEST_HINT],
      ['importer', 'a text file', writeText, 'file is not a database', ''],
      ['backtest', 'a database cut within its header', writeCutDatabase, 'database disk image is malformed', BACKTEST_HINT],
      ['importer', 'a database cut within its header', writeCutDatabase, 'database disk image is malformed', ''],
    ])('refuses in %s mode %s, naming its path', (runMode, _kind, write, failure, hint) => {
      const file = missingDatabase();
      write(file);
      storageConfig = { type: 'sqlite', database: file };
      mode = runMode;
      expect(() => new SQLiteStorage([symbol])).toThrow(`[STORAGE] Cannot open the database ${file} (${failure}).${hint}`);
    });

    it('names the path of a database it cannot create', () => {
      const blocked = join(directory, `${crypto.randomUUID()}.sql`);
      writeCandles(blocked); // A file, where the next database wants a directory
      storageConfig = { type: 'sqlite', database: join(blocked, 'candles.sql') };
      mode = 'importer';
      expect(() => new SQLiteStorage([symbol])).toThrow(`[STORAGE] Cannot open the database ${join(blocked, 'candles.sql')}`);
    });
  });
});
