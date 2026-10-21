import { ONE_MINUTE } from '@constants/time.const';
import { Candle } from '@models/candle.types';
import { warning } from '@services/logger';
import { toTimestamp } from '@utils/date/date.utils';
import { range } from 'lodash-es';
import { describe, expect, it, vi } from 'vitest';
import { CandleSize } from './candleBatcher.types';
import { FastCandleBatcher } from './fastCandleBatcher';

vi.mock('@services/logger', () => ({ warning: vi.fn() }));

const T0 = toTimestamp('2023-01-01T00:00:00Z');

const candleAt = (minute: number, override: Partial<Candle> = {}): Candle => ({
  start: T0 + minute * ONE_MINUTE,
  open: 100,
  high: 100,
  low: 100,
  close: 100,
  volume: 1000,
  ...override,
});

/** Feeds the candles in order and returns what each call returned */
const feed = (candleSize: CandleSize, candles: Candle[]) => {
  const batcher = new FastCandleBatcher(candleSize);
  return candles.map(candle => batcher.addCandle(candle));
};

describe('FastCandleBatcher', () => {
  describe('aggregation', () => {
    const fiveMinutes = [
      candleAt(0, { open: 10, high: 12, low: 9, close: 11, volume: 100 }),
      candleAt(1, { open: 11, high: 15, low: 11, close: 14, volume: 200 }),
      candleAt(2, { open: 14, high: 14, low: 8, close: 9, volume: 150 }),
      candleAt(3, { open: 9, high: 10, low: 9, close: 10, volume: 50 }),
      candleAt(4, { open: 10, high: 11, low: 10, close: 11, volume: 100 }),
    ];

    it('should return nothing until the timeframe candle closes', () => {
      expect(feed(5, fiveMinutes).slice(0, 4)).toEqual([null, null, null, null]);
    });

    it('should return the first open, highest high, lowest low, last close and total volume on the closing minute', () => {
      expect(feed(5, fiveMinutes)[4]).toEqual({ start: T0, open: 10, high: 15, low: 8, close: 11, volume: 600 });
    });

    it('should start a new timeframe candle after returning one', () => {
      const results = feed(5, [...fiveMinutes, ...range(5, 10).map(minute => candleAt(minute, { open: minute, close: minute }))]);
      expect(results[9]).toEqual({ start: T0 + 5 * ONE_MINUTE, open: 5, high: 100, low: 100, close: 9, volume: 5000 });
    });

    it('should not modify the candles it is given', () => {
      const first = candleAt(0, { high: 1, low: 1 });
      feed(5, [first, ...range(1, 5).map(minute => candleAt(minute, { high: 200, low: 50 }))]);
      expect(first).toEqual(candleAt(0, { high: 1, low: 1 }));
    });

    it('should carry over neither the id nor the synthetic flag of the first candle', () => {
      const [result] = feed(1, [candleAt(0, { id: 3, synthetic: true })]);
      expect(result).toStrictEqual({ start: T0, open: 100, high: 100, low: 100, close: 100, volume: 1000 });
    });
  });

  describe('volume', () => {
    // A batcher of as many minutes as volumes, fed from a boundary, returns the timeframe candle on the last one
    const sumVolumes = (volumes: number[]) =>
      feed(
        volumes.length as CandleSize,
        volumes.map((volume, minute) => candleAt(minute, { volume })),
      ).at(-1)?.volume;

    it.each`
      volumes                                        | expected
      ${[0.1, 0.2]}                                  | ${0.3}
      ${[1.5, 0.25, 0.125]}                          | ${1.875}
      ${[0.29, 0.58, 1.13]}                          | ${2}
      ${[12.34567891, 0.00012345, 3.1]}              | ${15.44580236}
      ${[0.1, 0.2, 0.30000000000000004, 1e-20, 2.4]} | ${3}
      ${[1e-7, 2e-7, 3e-7, 4e-7, 5e-7]}              | ${1.5e-6}
      ${[3, 0, 0, 1, 2]}                             | ${6}
    `('should sum $volumes to exactly $expected', ({ volumes, expected }) => {
      expect(sumVolumes(volumes)).toBe(expected);
    });

    it('should sum to NaN when a volume is not a number', () => {
      expect(sumVolumes([1.5, NaN])).toBeNaN();
    });

    it('should sum the volumes of the next timeframe candle from scratch', () => {
      const volumes = [0.12345678, 0.1, 1, 2];
      expect(
        feed(
          2,
          volumes.map((volume, minute) => candleAt(minute, { volume })),
        )[3]?.volume,
      ).toBe(3);
    });
  });

  describe('first candle off a timeframe boundary', () => {
    // 1h timeframe fed from 00:57: the minutes before 01:00 cannot make up a whole hour
    const fromMinute57 = range(57, 120).map(minute => candleAt(minute));

    it('should skip the candles before the first boundary, even a closing one', () => {
      expect(feed(60, fromMinute57).slice(0, 3)).toEqual([null, null, null]);
    });

    it('should start the first timeframe candle on the first boundary', () => {
      expect(feed(60, fromMinute57)[62]?.start).toBe(T0 + 60 * ONE_MINUTE);
    });

    // It knows no pair: one warning per pair of a bucket gave as many identical lines (CandleBucketBatcher warns once for the bucket)
    it('should skip them without a warning', () => {
      feed(60, fromMinute57);
      expect(warning).not.toHaveBeenCalled();
    });

    it('should no longer skip a candle once started', () => {
      // Sparse on purpose: the batcher itself does not check that the minutes follow each other
      expect(feed(60, [candleAt(0), candleAt(119)])[1]?.start).toBe(T0);
    });
  });
});
