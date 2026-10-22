import type { Candle } from '@gekko/shared/models/candle.types';
import { describe, expect, it } from 'bun:test';
import { candleAt, candlesClosingAt, minute } from './backtestRun.helper';

describe('backtestRun.helper', () => {
  describe('candleAt', () => {
    it.each<[string, { open: number; close: number }, Pick<Candle, 'high' | 'low'>]>([
      [
        'its high and its low the spread off its close when it opens between them',
        { open: 10050, close: 10000 },
        { high: 10100, low: 9900 },
      ],
      ['its high stretched to an open above it', { open: 10000, close: 9500 }, { high: 10000, low: 9400 }],
      ['its low stretched to an open below it', { open: 2000, close: 2200 }, { high: 2300, low: 2000 }],
    ])('should build a candle with %s', (_title, { open, close }, bounds) => {
      expect(candleAt(3, { open, close, spread: 100, volume: 10 })).toEqual({ start: minute(3), open, ...bounds, close, volume: 10 });
    });
  });

  describe('candlesClosingAt', () => {
    it('should build the candles of 00:00 to 00:08 opening at the open, each closing at its price of `closes` or at the open', () => {
      expect(candlesClosingAt({ 2: 10300, 5: 9600 }).map(({ start, open, high, low, close }) => [start, open, high, low, close])).toEqual([
        [minute(0), 10000, 10100, 9900, 10000],
        [minute(1), 10000, 10100, 9900, 10000],
        // Stretched to the open, below the low 100 under its close
        [minute(2), 10000, 10400, 10000, 10300],
        [minute(3), 10000, 10100, 9900, 10000],
        [minute(4), 10000, 10100, 9900, 10000],
        // Stretched to the open, above the high 100 over its close
        [minute(5), 10000, 10000, 9500, 9600],
        [minute(6), 10000, 10100, 9900, 10000],
        [minute(7), 10000, 10100, 9900, 10000],
        [minute(8), 10000, 10100, 9900, 10000],
      ]);
    });
  });
});
