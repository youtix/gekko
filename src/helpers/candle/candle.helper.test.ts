import { ONE_MINUTE } from '@constants/time.const';
import { TIMEFRAME_TO_MINUTES } from '@constants/timeframe.const';
import { Candle } from '@models/candle.types';
import { TIMEFRAMES } from '@services/configuration/configuration.const';
import { isTimeframeCandleClose } from '@services/core/batcher/candleBatcher/candleBatcher.helper';
import { CandleSize } from '@services/core/batcher/candleBatcher/candleBatcher.types';
import { FastCandleBatcher } from '@services/core/batcher/candleBatcher/fastCandleBatcher';
import { toISOString, toTimestamp } from '@utils/date/date.utils';
import { range, sortedUniq } from 'lodash-es';
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

describe('candle utils', () => {
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
      expect(() => getFirstCandleFromBucket(new Map())).toThrow('Impossible to get first candle from bucket: Empty candle bucket');
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
      expect(() => getCandleTimeOffset(45 as CandleSize, defaultCandle.start)).toThrow('[UTILS] Unsupported candle size: 45 minutes');
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

    describe('replayed through the TradingAdvisor batcher', () => {
      // Every month of 2023-2028 (2024 and 2028 are leap years): its first, second, a middle and its last minute
      const minutes = range(2023, 2029).flatMap(year =>
        range(12).flatMap(month => [
          Date.UTC(year, month, 1, 0, 0),
          Date.UTC(year, month, 1, 0, 1),
          Date.UTC(year, month, 15, 12, 34),
          Date.UTC(year, month + 1, 0, 23, 59),
        ]),
      );
      // Candles close on the last minute of a month (1M and longer), of a day (1d, 1w) or of an intraday candle
      const monthEnds = range(12 * 12).map(month => Date.UTC(2018, month + 1, 1) - ONE_MINUTE);
      const closeCandidates = (size: CandleSize, start: EpochTimeStamp, end: EpochTimeStamp) => {
        if (size >= TIMEFRAME_TO_MINUTES['1M']) return monthEnds;
        const step = Math.min(size, TIMEFRAME_TO_MINUTES['1d']) * ONE_MINUTE;
        return range(Math.ceil((start + ONE_MINUTE) / step) * step - ONE_MINUTE, end + 1, step);
      };

      // Feeds the batcher the history from `start` to `end`: its first and last minutes and every candle close in between
      const replay = (size: CandleSize, start: EpochTimeStamp, end: EpochTimeStamp) => {
        const closes = closeCandidates(size, start, end).filter(minute => minute > start && minute < end);
        const history = start > end ? [] : sortedUniq([start, ...closes, end]);
        const batcher = new FastCandleBatcher(size);
        return {
          // The history starts on a candle boundary when the minute before it closes a candle
          startsOnBoundary: isTimeframeCandleClose(size, start - ONE_MINUTE),
          closedCandles: history.filter(minute => batcher.addCandle({ ...defaultCandle, start: minute })).length,
        };
      };

      // Every timeframe, read from TIMEFRAMES rather than written as a table, so that one added to TIMEFRAME_TO_MINUTES is replayed too
      it.each(TIMEFRAMES)(
        'should start on a %s candle boundary from which exactly count candles close before the one in progress, at any date',
        timeframe => {
          const size = TIMEFRAME_TO_MINUTES[timeframe];
          const failures = [0, 1, 2, 3].flatMap(count =>
            minutes
              .map(minute => ({
                minute: toISOString(minute),
                count,
                ...replay(size, getCandleStart(size, minute, count), minute - ONE_MINUTE),
              }))
              .filter(({ startsOnBoundary, closedCandles }) => !startsOnBoundary || closedCandles !== count),
          );
          expect(failures).toEqual([]);
        },
      );
    });
  });
});
