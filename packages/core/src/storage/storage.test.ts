import { Candle } from '@gekko/shared/models/candle.types';
import { CandleBucket } from '@gekko/shared/models/event.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from './storage';
import { INSERT_THRESHOLD } from './storage.const';

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { getWatch: vi.fn(), getStorage: vi.fn() },
}));

vi.mock('../configuration/configuration', () => ({ config: mockConfig }));

class TestStorage extends Storage {
  public insertCandles = vi.fn();
  public createTable = vi.fn();
  public getCandleDateranges = vi.fn();
  public getCandles = vi.fn();
  public checkInterval = vi.fn();
  public close = vi.fn();
}

describe('Storage', () => {
  beforeEach(() => {
    mockConfig.getWatch.mockReturnValue({ mode: 'backtest' });
    mockConfig.getStorage.mockReturnValue({ type: 'sqlite', database: ':memory:' });
  });

  describe('constructor', () => {
    it.each`
      mode          | storage                   | expected
      ${'backtest'} | ${{ insertThreshold: 5 }} | ${5}
      ${'realtime'} | ${{ insertThreshold: 5 }} | ${5}
      ${'importer'} | ${{ insertThreshold: 1 }} | ${1}
      ${'realtime'} | ${undefined}              | ${1}
      ${'realtime'} | ${{}}                     | ${1}
      ${'importer'} | ${undefined}              | ${INSERT_THRESHOLD}
      ${'importer'} | ${{}}                     | ${INSERT_THRESHOLD}
      ${'backtest'} | ${{}}                     | ${INSERT_THRESHOLD}
    `('sets the insert threshold to $expected in $mode mode with storage $storage', ({ mode, storage, expected }) => {
      mockConfig.getWatch.mockReturnValue({ mode });
      mockConfig.getStorage.mockReturnValue(storage);
      expect(new TestStorage()['insertThreshold']).toBe(expected);
    });

    it.each`
      mode          | expected
      ${'importer'} | ${true}
      ${'realtime'} | ${false}
      ${'backtest'} | ${false}
    `('gives the real candles written the last word in $mode mode: $expected', ({ mode, expected }) => {
      mockConfig.getWatch.mockReturnValue({ mode });
      expect(new TestStorage()['hasLastWord']).toBe(expected);
    });
  });

  describe('addBucket', () => {
    const bucket: CandleBucket = new Map([
      ['BTC/USDT', { start: 0 } as Candle],
      ['ETH/USDT', { start: 0 } as Candle],
    ]);
    let storage: TestStorage;

    beforeEach(() => {
      mockConfig.getStorage.mockReturnValue({ type: 'sqlite', database: ':memory:', insertThreshold: 2 });
      storage = new TestStorage();
    });

    it('keeps the bucket in the buffer while the insert threshold is not reached', () => {
      storage.addBucket(bucket);
      expect(storage.insertCandles).not.toHaveBeenCalled();
    });

    it.each`
      scenario                                 | buckets                                                 | expected
      ${'every pair in both buckets'}          | ${[['BTC/USDT', 'ETH/USDT'], ['BTC/USDT', 'ETH/USDT']]} | ${[['BTC/USDT'], ['ETH/USDT']]}
      ${'a pair missing from the last bucket'} | ${[['BTC/USDT', 'ETH/USDT'], ['BTC/USDT']]}             | ${[['BTC/USDT'], ['ETH/USDT']]}
      ${'a pair only in the last bucket'}      | ${[['BTC/USDT'], ['ETH/USDT']]}                         | ${[['BTC/USDT'], ['ETH/USDT']]}
    `('inserts the candles of every buffered pair once the insert threshold is reached, with $scenario', ({ buckets, expected }) => {
      for (const symbols of buckets) storage.addBucket(new Map(symbols.map((symbol: string) => [symbol, { start: 0 } as Candle])));
      expect(storage.insertCandles.mock.calls).toEqual(expected);
    });

    it('empties the buffer once the candles are inserted', () => {
      storage.addBucket(bucket);
      storage.addBucket(bucket);
      expect(storage['buffer']).toEqual([]);
    });
  });

  // close() counts what a failed flush left out of the database from the buffer and the pairs inserted before the failure
  describe('flush, when an insert fails', () => {
    const symbols: TradingPair[] = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
    let storage: TestStorage;

    /** Flushes, swallowing the failure, so that the test can check what it left */
    const attemptFlush = (inserted?: Set<TradingPair>) => {
      try {
        storage['flush'](inserted);
      } catch {
        // Expected
      }
    };

    beforeEach(() => {
      mockConfig.getStorage.mockReturnValue({ type: 'sqlite', database: ':memory:', insertThreshold: 10 });
      storage = new TestStorage();
      storage.addBucket(new Map(symbols.map(symbol => [symbol, { start: 0 } as Candle])));
      storage.insertCandles.mockImplementation((symbol: string) => {
        if (symbol === 'ETH/USDT') throw new Error('database is locked');
      });
    });

    it('rethrows the failure', () => {
      expect(() => storage['flush']()).toThrow('database is locked');
    });

    it('collects the pairs it inserted before it', () => {
      const inserted = new Set<TradingPair>();
      attemptFlush(inserted);
      expect([...inserted]).toEqual(['BTC/USDT']);
    });

    it('keeps the whole buffer', () => {
      attemptFlush();
      expect(storage['buffer']).toHaveLength(1);
    });
  });

  describe('getTable', () => {
    it.each`
      symbol                  | expected
      ${'BTC/USDT'}           | ${'CANDLES_BTC_USDT'}
      ${'btc/usdt'}           | ${'CANDLES_BTC_USDT'}
      ${'Eth/Usdt'}           | ${'CANDLES_ETH_USDT'}
      ${'1INCH/USDT'}         | ${'CANDLES_1INCH_USDT'}
      ${'C98/USDT'}           | ${'CANDLES_C98_USDT'}
      ${'1000SATS/USDT'}      | ${'CANDLES_1000SATS_USDT'}
      ${'BTC/USD1'}           | ${'CANDLES_BTC_USD1'}
      ${'kPEPE/USDC'}         | ${'CANDLES_KPEPE_USDC'}
      ${'FLX-CRCL/USDC:USDC'} | ${'CANDLES_FLX-CRCL_USDC:USDC'}
    `('names the table of $symbol $expected', ({ symbol, expected }) => {
      expect(new TestStorage()['getTable'](symbol)).toBe(expected);
    });
  });
});
