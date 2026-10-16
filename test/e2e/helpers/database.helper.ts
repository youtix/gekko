import { Candle } from '@models/candle.types';
import { TradingPair } from '@models/utility.types';
import type { SQLiteStorage } from '@services/storage/sqlite.storage';

/** The quoted name of the table of the pair, asked of the storage: test/e2e/storage checks the names it gives */
const tableOf = (storage: SQLiteStorage, symbol: TradingPair) => storage['getQuotedTable'](symbol);

/** The candle tables of the database, by name, in alphabetical order */
export const candleTables = (storage: SQLiteStorage) =>
  storage.db
    .query<{ name: string }, [string, string]>('SELECT name FROM sqlite_master WHERE type = ? AND name LIKE ? ORDER BY name')
    .all('table', 'candles_%')
    .map(({ name }) => name);

/**
 * Writes the candles as they are, without the rules by which the storage replaces a stored candle. A field left out is 0, but the high
 * and the low, which default to the higher and the lower of the open and the close, as the ccxt mock gives them: at 0, a seeded candle
 * had a low that any LIMIT BUY of the simulator reaches.
 */
export const seedDatabaseWithCandles = (storage: SQLiteStorage, symbol: TradingPair, candles: Partial<Candle>[]) => {
  storage.createTable(symbol);

  const stmt = storage.db.prepare(
    `INSERT INTO ${tableOf(storage, symbol)} (start, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const insertTx = storage.db.transaction((records: Partial<Candle>[]) => {
    for (const record of records) {
      if (record.start === undefined) {
        throw new Error('Candle must have a start time');
      }
      const { start, open = 0, close = 0, high = Math.max(open, close), low = Math.min(open, close), volume = 0 } = record;
      stmt.run(start, open, high, low, close, volume);
    }
  });

  try {
    insertTx(candles);
  } finally {
    stmt.finalize();
  }
};

/** The candles stored for the pair, those starting within `range` when one is given, both bounds included */
export const countCandles = (storage: SQLiteStorage, symbol: TradingPair, range?: { start: number; end: number }) => {
  const table = tableOf(storage, symbol);
  const { count } = (
    range
      ? storage.db.query(`SELECT count(*) AS count FROM ${table} WHERE start BETWEEN ? AND ?`).get(range.start, range.end)
      : storage.db.query(`SELECT count(*) AS count FROM ${table}`).get()
  ) as { count: number };
  return count;
};

/**
 * Every candle stored for the pair, oldest first, as its table holds it, an off-grid start included, without the row id: what a flow
 * compares with the candles it expects, rather than a count, a first and a last row
 */
export const readCandles = (storage: SQLiteStorage, symbol: TradingPair): Candle[] =>
  storage.db.query<Candle, []>(`SELECT start, open, high, low, close, volume FROM ${tableOf(storage, symbol)} ORDER BY start`).all();
