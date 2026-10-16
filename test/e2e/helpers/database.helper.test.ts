import type { SQLiteStorage as Storage } from '@services/storage/sqlite.storage';
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanDatabase, countCandles, seedDatabaseWithCandles } from './database.helper';

// Defined before the storage is imported, which reads the configuration as it loads
mock.module('@services/configuration/configuration', () => ({
  config: {
    getStorage: () => ({ type: 'sqlite', database: ':memory:' }),
    getWatch: () => ({ mode: 'backtest' }),
  },
}));

describe('database.helper', () => {
  const symbol = 'BTC/USDT';
  const firstHour = { start: 0, end: 60 * 60_000 };
  let SQLiteStorage: typeof Storage;
  let storage: Storage;

  beforeAll(async () => {
    ({ SQLiteStorage } = await import('@services/storage/sqlite.storage'));
  });

  beforeEach(() => {
    storage = new SQLiteStorage([symbol]);
  });

  afterEach(() => {
    storage.close();
  });

  describe('seedDatabaseWithCandles', () => {
    it('should store the candles as given, a field left out at 0 but the high and the low at those of the open and the close', () => {
      seedDatabaseWithCandles(storage, symbol, [
        { start: 960000, open: 100, high: 105, low: 95, close: 100 },
        { start: 1020000, open: 100, close: 110, volume: 50 },
      ]);
      expect(storage.getCandles(symbol, firstHour)).toEqual([
        { id: 1, start: 960000, open: 100, high: 105, low: 95, close: 100, volume: 0 },
        { id: 2, start: 1020000, open: 100, high: 110, low: 100, close: 110, volume: 50 },
      ]);
    });

    it.each(['1INCH/USDT', 'FLX-CRCL/USDC:USDC'])('should seed the table the storage reads for %s', pair => {
      seedDatabaseWithCandles(storage, pair, [{ start: 960000 }]);
      expect(storage.getCandles(pair, firstHour)).toHaveLength(1);
    });

    it('should refuse a candle without a start', () => {
      expect(() => seedDatabaseWithCandles(storage, symbol, [{ open: 100 }])).toThrow('Candle must have a start time');
    });

    it('should store none of the candles when one has no start', () => {
      try {
        seedDatabaseWithCandles(storage, symbol, [{ start: 960000 }, { open: 100 }]);
      } catch {
        // Refused, as the previous test checks
      }
      expect(storage.getCandles(symbol, firstHour)).toEqual([]);
    });
  });

  describe('cleanDatabase', () => {
    it('should empty a table whose name needs quoting', () => {
      seedDatabaseWithCandles(storage, 'FLX-CRCL/USDC:USDC', [{ start: 960000 }]);
      cleanDatabase(storage);
      expect(storage.getCandles('FLX-CRCL/USDC:USDC', firstHour)).toEqual([]);
    });
  });

  describe('countCandles', () => {
    it.each([
      { within: 'every minute stored, without a range', range: undefined, count: 3 },
      { within: 'a range, both bounds included', range: { start: 60000, end: 120000 }, count: 2 },
      { within: 'a range between two candles', range: { start: 60001, end: 119999 }, count: 0 },
    ])('should count $count candles within $within', ({ range, count }) => {
      seedDatabaseWithCandles(storage, symbol, [{ start: 0 }, { start: 60000 }, { start: 120000 }]);
      expect(countCandles(storage, symbol, range)).toBe(count);
    });
  });
});
