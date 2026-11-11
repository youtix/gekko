import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import { TIMEFRAME_TO_MINUTES } from '@gekko/shared/constants/timeframe.const';
import { TIMEFRAMES } from '@gekko/schemas/configuration/configuration.const';
import { getCandleStart } from '@gekko/shared/helpers/candle/candle.helper';
import { toISOString, toTimestamp } from '@gekko/shared/utils/date/date.utils';
import { range, sortedUniq } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import { isTimeframeCandleClose } from './candleBatcher.helper';
import { FastCandleBatcher } from './fastCandleBatcher';
import { Candle } from '@gekko/shared/models/candle.types';
import { CandleSize } from '@gekko/shared/models/candleSize.types';

describe('isTimeframeCandleClose', () => {
  it.each`
    size      | minute                    | expected
    ${1}      | ${'2024-01-01T00:00:00Z'} | ${true}
    ${2}      | ${'2024-01-01T00:01:00Z'} | ${true}
    ${2}      | ${'2024-01-01T00:02:00Z'} | ${false}
    ${3}      | ${'2024-01-01T00:02:00Z'} | ${true}
    ${3}      | ${'2024-01-01T00:03:00Z'} | ${false}
    ${5}      | ${'2024-01-01T00:04:00Z'} | ${true}
    ${5}      | ${'2024-01-01T00:03:00Z'} | ${false}
    ${10}     | ${'2024-01-01T00:09:00Z'} | ${true}
    ${10}     | ${'2024-01-01T00:08:00Z'} | ${false}
    ${15}     | ${'2024-01-01T00:14:00Z'} | ${true}
    ${15}     | ${'2024-01-01T00:15:00Z'} | ${false}
    ${30}     | ${'2024-01-01T00:29:00Z'} | ${true}
    ${30}     | ${'2024-01-01T00:30:00Z'} | ${false}
    ${60}     | ${'2024-01-01T00:59:00Z'} | ${true}
    ${60}     | ${'2024-01-01T00:58:00Z'} | ${false}
    ${120}    | ${'2024-01-01T01:59:00Z'} | ${true}
    ${120}    | ${'2024-01-01T00:59:00Z'} | ${false}
    ${240}    | ${'2024-01-01T03:59:00Z'} | ${true}
    ${240}    | ${'2024-01-01T01:59:00Z'} | ${false}
    ${360}    | ${'2024-01-01T05:59:00Z'} | ${true}
    ${360}    | ${'2024-01-01T03:59:00Z'} | ${false}
    ${480}    | ${'2024-01-01T07:59:00Z'} | ${true}
    ${480}    | ${'2024-01-01T05:59:00Z'} | ${false}
    ${720}    | ${'2024-01-01T11:59:00Z'} | ${true}
    ${720}    | ${'2024-01-01T07:59:00Z'} | ${false}
    ${1440}   | ${'2024-01-01T23:59:00Z'} | ${true}
    ${1440}   | ${'2024-01-01T22:59:00Z'} | ${false}
    ${1440}   | ${'2024-02-29T23:59:00Z'} | ${true}
    ${10080}  | ${'2024-01-07T23:59:00Z'} | ${true}
    ${10080}  | ${'2024-01-06T23:59:00Z'} | ${false}
    ${10080}  | ${'2024-03-31T23:59:00Z'} | ${true}
    ${10080}  | ${'2024-02-29T23:59:00Z'} | ${false}
    ${43200}  | ${'2024-01-31T23:59:00Z'} | ${true}
    ${43200}  | ${'2024-01-30T23:59:00Z'} | ${false}
    ${43200}  | ${'2023-02-28T23:59:00Z'} | ${true}
    ${43200}  | ${'2024-02-28T23:59:00Z'} | ${false}
    ${43200}  | ${'2024-02-29T23:58:00Z'} | ${false}
    ${43200}  | ${'2024-02-29T23:59:00Z'} | ${true}
    ${43200}  | ${'2024-03-01T00:00:00Z'} | ${false}
    ${43200}  | ${'2024-04-30T23:59:00Z'} | ${true}
    ${43200}  | ${'2024-12-31T23:59:00Z'} | ${true}
    ${129600} | ${'2024-03-31T23:59:00Z'} | ${true}
    ${129600} | ${'2024-03-31T23:58:00Z'} | ${false}
    ${129600} | ${'2024-02-29T23:59:00Z'} | ${false}
    ${129600} | ${'2024-04-30T23:59:00Z'} | ${false}
    ${129600} | ${'2024-06-30T23:59:00Z'} | ${true}
    ${129600} | ${'2024-09-30T23:59:00Z'} | ${true}
    ${129600} | ${'2024-12-31T23:59:00Z'} | ${true}
    ${259200} | ${'2024-06-30T23:59:00Z'} | ${true}
    ${259200} | ${'2024-06-29T23:59:00Z'} | ${false}
    ${259200} | ${'2024-12-31T23:59:00Z'} | ${true}
    ${259200} | ${'2024-03-31T23:59:00Z'} | ${false}
    ${259200} | ${'2024-09-30T23:59:00Z'} | ${false}
    ${259200} | ${'2024-02-29T23:59:00Z'} | ${false}
    ${518400} | ${'2024-12-31T23:59:00Z'} | ${true}
    ${518400} | ${'2024-12-31T23:58:00Z'} | ${false}
    ${518400} | ${'2024-12-30T23:59:00Z'} | ${false}
    ${518400} | ${'2024-06-30T23:59:00Z'} | ${false}
    ${518400} | ${'2024-02-29T23:59:00Z'} | ${false}
    ${518400} | ${'2025-12-31T23:59:00Z'} | ${true}
  `('should return $expected for a $size-minute candle at $minute', ({ size, minute, expected }) => {
    expect(isTimeframeCandleClose(size, toTimestamp(minute))).toBe(expected);
  });

  it('should throw on a candle size that is not a timeframe', () => {
    expect(() => isTimeframeCandleClose(45 as CandleSize, toTimestamp('2023-01-01T00:00:00Z'))).toThrow(
      '[CORE] Unsupported candle size: 45 minutes',
    );
  });
});

// getCandleStart (a shared helper) against the batcher: the warmup window and the timeframe candles must share their boundaries
describe('getCandleStart replayed through the TradingAdvisor batcher', () => {
  const defaultCandle: Candle = {
    close: 100,
    high: 150,
    low: 90,
    open: 110,
    start: toTimestamp('2025'),
    volume: 10,
  };

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
