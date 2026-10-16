import { Candle } from '@models/candle.types';
import { TradingPair } from '@models/utility.types';
import type { SQLiteStorage } from '@services/storage/sqlite.storage';

// Same quoting as SQLiteStorage: table names can hold digits and punctuation
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** The quoted name of the table of the pair, asked of the storage: test/e2e/storage checks the names it gives */
const tableOf = (storage: SQLiteStorage, symbol: TradingPair) => storage['getQuotedTable'](symbol);

export const cleanDatabase = (storage: SQLiteStorage) => {
  const db = storage.db;
  const tables = db.query('SELECT name FROM sqlite_master WHERE type = ? AND name LIKE ?').all('table', 'candles_%') as { name: string }[];

  for (const { name } of tables) {
    db.run(`DELETE FROM ${quote(name)}`);
  }
};

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
