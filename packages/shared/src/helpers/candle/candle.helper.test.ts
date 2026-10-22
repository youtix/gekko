import { ONE_MINUTE } from '../../constants/time.const';
import { Candle } from '../../models/candle.types';
import { CandleSize } from '../../models/candleSize.types';
import { toTimestamp } from '../../utils/date/date.utils';
import { describe, expect, it } from 'vitest';
import {
  createEmptyCandle,
  getBucketTimestamp,
  getCandleStart,
  getCandleTimeOffset,
  getFirstCandleFromBucket,
  hl2,
  hlc3,
  ohlc4,
} from './candle.helper';

describe('candle.helper', () => {
  const defaultCandle: Candle = {
    close: 100,
    high: 150,
    low: 90,
    open: 110,
    start: toTimestamp('2025'),
    volume: 10,
  };

  describe('hl2', () => {
    it.each`
      high   | low    | expected
      ${5}   | ${3}   | ${4}
      ${10}  | ${2}   | ${6}
      ${1.5} | ${0.5} | ${1}
    `('returns $expected for high=$high and low=$low', ({ high, low, expected }) => {
      const candle = { ...defaultCandle, high, low };
      expect(hl2(candle)).toBe(expected);
    });
  });

  // The prices and the means are exact in binary, so they are compared exactly: toBeCloseTo, at its default 2 digits, let a divisor of
  // 3.001 or 4.001 through
  describe('hlc3', () => {
    it.each`
      high | low    | close | expected
      ${5} | ${3}   | ${4}  | ${4}
      ${6} | ${2}   | ${4}  | ${4}
      ${4} | ${0.5} | ${3}  | ${2.5}
    `('returns $expected for high=$high, low=$low and close=$close', ({ high, low, close, expected }) => {
      const candle = { ...defaultCandle, high, low, close };
      expect(hlc3(candle)).toBe(expected);
    });
  });

  describe('ohlc4', () => {
    it.each`
      open   | high   | low    | close   | expected
      ${1}   | ${5}   | ${3}   | ${4}    | ${3.25}
      ${10}  | ${4}   | ${2}   | ${8}    | ${6}
      ${1.5} | ${3.5} | ${0.5} | ${2.25} | ${1.9375}
    `('returns $expected for open=$open, high=$high, low=$low and close=$close', ({ open, high, low, close, expected }) => {
      const candle = { ...defaultCandle, open, high, low, close };
      expect(ohlc4(candle)).toBe(expected);
    });
  });

  describe('createEmptyCandle', () => {
    it('should make up the next minute flat at the last close, with no volume, marked synthetic and without id', () => {
      expect(createEmptyCandle({ ...defaultCandle, id: 7 })).toEqual({
        start: defaultCandle.start + ONE_MINUTE,
        open: 100,
        high: 100,
        low: 100,
        close: 100,
        volume: 0,
        synthetic: true,
      });
    });
  });

  describe('getBucketTimestamp', () => {
    it('should return the start of the candles of a bucket', () => {
      expect(getBucketTimestamp(new Map([['BTC/USDT', defaultCandle]]))).toBe(defaultCandle.start);
    });

    it('should return undefined for an empty bucket', () => {
      expect(getBucketTimestamp(new Map())).toBeUndefined();
    });
  });

  describe('getFirstCandleFromBucket', () => {
    it('should return the first candle of a bucket', () => {
      expect(getFirstCandleFromBucket(new Map([['BTC/USDT', defaultCandle]]))).toBe(defaultCandle);
    });

    it('should throw on an empty bucket', () => {
      expect(() => getFirstCandleFromBucket(new Map())).toThrow('[CORE] Impossible to get first candle from bucket: Empty candle bucket');
    });
  });

  describe('getCandleTimeOffset', () => {
    // Sunday 2025-06-22 19:53:30, 1193 minutes after midnight, 21 days into June, 82 into the quarter, 172 into the year
    it.each`
      size      | expected
      ${1}      | ${0}
      ${2}      | ${1}
      ${3}      | ${2}
      ${5}      | ${3}
      ${10}     | ${3}
      ${15}     | ${8}
      ${30}     | ${23}
      ${60}     | ${53}
      ${120}    | ${113}
      ${240}    | ${233}
      ${360}    | ${113}
      ${480}    | ${233}
      ${720}    | ${473}
      ${1440}   | ${1193}
      ${10080}  | ${6 * 1440 + 1193}
      ${43200}  | ${21 * 1440 + 1193}
      ${129600} | ${82 * 1440 + 1193}
      ${259200} | ${172 * 1440 + 1193}
      ${518400} | ${172 * 1440 + 1193}
    `('should return $expected minutes into a $size-minute candle', ({ size, expected }) => {
      expect(getCandleTimeOffset(size, toTimestamp('2025-06-22T19:53:30Z'))).toBe(expected);
    });

    // A candle of whole months starts on the first of a month, its periods counted from January, and lasts as long as its months do
    it.each`
      size      | minute                    | expected
      ${43200}  | ${'2024-02-01T00:00:00Z'} | ${0}
      ${43200}  | ${'2024-02-29T23:59:00Z'} | ${29 * 1440 - 1}
      ${43200}  | ${'2024-03-01T00:00:00Z'} | ${0}
      ${43200}  | ${'2023-02-28T23:59:00Z'} | ${28 * 1440 - 1}
      ${129600} | ${'2024-01-01T00:00:00Z'} | ${0}
      ${129600} | ${'2024-03-31T23:59:00Z'} | ${(31 + 29 + 31) * 1440 - 1}
      ${129600} | ${'2024-04-01T00:00:00Z'} | ${0}
      ${129600} | ${'2023-03-31T23:59:00Z'} | ${(31 + 28 + 31) * 1440 - 1}
      ${259200} | ${'2024-06-30T23:59:00Z'} | ${(31 + 29 + 31 + 30 + 31 + 30) * 1440 - 1}
      ${259200} | ${'2024-07-01T00:00:00Z'} | ${0}
      ${259200} | ${'2024-12-31T23:59:00Z'} | ${(31 + 31 + 30 + 31 + 30 + 31) * 1440 - 1}
      ${518400} | ${'2024-12-31T23:59:00Z'} | ${366 * 1440 - 1}
      ${518400} | ${'2025-01-01T00:00:00Z'} | ${0}
      ${518400} | ${'2025-12-31T23:59:00Z'} | ${365 * 1440 - 1}
    `('should return $expected minutes into the $size-minute candle holding $minute', ({ size, minute, expected }) => {
      expect(getCandleTimeOffset(size, toTimestamp(minute))).toBe(expected);
    });

    it('should throw on a candle size that is not a timeframe', () => {
      expect(() => getCandleTimeOffset(45 as CandleSize, defaultCandle.start)).toThrow('[CORE] Unsupported candle size: 45 minutes');
    });
  });

  describe('getCandleStart', () => {
    it.each`
      size      | minute                    | count | expected
      ${1}      | ${'2024-02-29T23:59:00Z'} | ${0}  | ${'2024-02-29T23:59:00Z'}
      ${1}      | ${'2024-03-01T00:00:00Z'} | ${3}  | ${'2024-02-29T23:57:00Z'}
      ${5}      | ${'2024-03-01T10:23:00Z'} | ${2}  | ${'2024-03-01T10:10:00Z'}
      ${240}    | ${'2024-03-01T10:23:00Z'} | ${1}  | ${'2024-03-01T04:00:00Z'}
      ${1440}   | ${'2024-03-01T10:23:00Z'} | ${1}  | ${'2024-02-29T00:00:00Z'}
      ${10080}  | ${'2024-03-01T10:23:00Z'} | ${1}  | ${'2024-02-19T00:00:00Z'}
      ${43200}  | ${'2024-03-15T10:23:00Z'} | ${0}  | ${'2024-03-01T00:00:00Z'}
      ${43200}  | ${'2024-03-15T10:23:00Z'} | ${1}  | ${'2024-02-01T00:00:00Z'}
      ${43200}  | ${'2024-01-15T10:23:00Z'} | ${2}  | ${'2023-11-01T00:00:00Z'}
      ${129600} | ${'2024-05-15T10:23:00Z'} | ${1}  | ${'2024-01-01T00:00:00Z'}
      ${129600} | ${'2024-02-10T10:23:00Z'} | ${2}  | ${'2023-07-01T00:00:00Z'}
      ${259200} | ${'2024-08-15T10:23:00Z'} | ${1}  | ${'2024-01-01T00:00:00Z'}
      ${259200} | ${'2024-03-15T10:23:00Z'} | ${3}  | ${'2022-07-01T00:00:00Z'}
      ${518400} | ${'2024-12-31T23:59:00Z'} | ${0}  | ${'2024-01-01T00:00:00Z'}
      ${518400} | ${'2024-03-15T10:23:00Z'} | ${2}  | ${'2022-01-01T00:00:00Z'}
    `('should return $expected for $count candles of $size minutes before the one holding $minute', ({ size, minute, count, expected }) => {
      expect(getCandleStart(size, toTimestamp(minute), count)).toBe(toTimestamp(expected));
    });
  });
});
