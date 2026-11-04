import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { Candle } from '@gekko/shared/models/candle.types';
import { CandleBucket } from '@gekko/shared/models/event.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { warning } from '../../../logger/logger';
import { toISOString, toTimestamp } from '@gekko/shared/utils/date/date.utils';
import { range } from 'lodash-es';
import { describe, expect, it, vi } from 'vitest';
import { CandleBucketBatcher } from './candleBucketBatcher';

vi.mock('../../../logger/logger', () => ({ warning: vi.fn() }));

const BTC: TradingPair = 'BTC/USDT';
const ETH: TradingPair = 'ETH/USDT';
const T0 = toTimestamp('2023-01-01T00:00:00Z');
const at = (minute: number) => T0 + minute * ONE_MINUTE;

// BTC and ETH prices differ, so that a candle of one pair cannot pass for the other
const candleAt = (pair: TradingPair, minute: number): Candle => {
  const price = (pair === BTC ? 20_000 : 1_000) + minute;
  return { start: at(minute), open: price, high: price + 5, low: price - 5, close: price + 1, volume: 2 };
};

const bucketAt = (minute: number, pairs: TradingPair[] = [BTC, ETH]): CandleBucket =>
  new Map(pairs.map(pair => [pair, candleAt(pair, minute)]));

/** Feeds the 5-minute batcher of BTC and ETH one bucket per minute and returns what each call returned */
const feed = (minutes: number[]) => {
  const batcher = new CandleBucketBatcher([BTC, ETH], 5);
  return minutes.map(minute => batcher.addBucket(bucketAt(minute)));
};

describe('CandleBucketBatcher', () => {
  it('should count the pairs it batches', () => {
    expect(new CandleBucketBatcher([BTC, ETH], 5).pairCount).toBe(2);
  });

  it('should refuse to batch no pair at all', () => {
    expect(() => new CandleBucketBatcher([], 5)).toThrow('CandleBucketBatcher needs at least one pair');
  });

  describe('batching', () => {
    it('should return nothing until the timeframe candle closes', () => {
      expect(feed(range(0, 4))).toEqual([undefined, undefined, undefined, undefined]);
    });

    it('should return the timeframe candle of every pair when it closes', () => {
      expect(feed(range(0, 5))[4]).toEqual(
        new Map([
          [BTC, { start: at(0), open: 20_000, high: 20_009, low: 19_995, close: 20_005, volume: 10 }],
          [ETH, { start: at(0), open: 1_000, high: 1_009, low: 995, close: 1_005, volume: 10 }],
        ]),
      );
    });

    it('should return the timeframe candles of the next period once the first one closed', () => {
      expect(feed(range(0, 10))[9]?.get(ETH)).toEqual({ start: at(5), open: 1_005, high: 1_014, low: 1_000, close: 1_010, volume: 10 });
    });

    it('should ignore the candles of a pair it does not batch', () => {
      const batcher = new CandleBucketBatcher([BTC], 1);
      expect(batcher.addBucket(bucketAt(0, [ETH, BTC]))).toEqual(new Map([[BTC, { ...candleAt(BTC, 0) }]]));
    });

    it('should return nothing on the close of a timeframe candle that started before its first bucket', () => {
      expect(feed(range(3, 5))).toEqual([undefined, undefined]);
    });

    it('should return the first whole timeframe candle after skipping the minutes before the first boundary', () => {
      expect(feed(range(3, 10))[6]?.get(BTC)?.start).toBe(at(5));
    });

    // Each pair's batcher warned of the minutes it skipped, without naming its pair: two pairs gave two identical lines
    it.each`
      from | skipped
      ${4} | ${'1 one-minute candle'}
      ${3} | ${'2 one-minute candles'}
    `(
      'should warn once for the bucket, whatever its pairs, about the minutes skipped before the first boundary: $skipped',
      ({ from, skipped }) => {
        feed(range(from, 10));
        expect(warning).toHaveBeenCalledExactlyOnceWith(
          'core',
          `Skipped ${skipped} from ${toISOString(at(from))}: the first 5-minute candle starts on the first boundary, ${toISOString(at(5))}`,
        );
      },
    );

    it('should not warn when the first bucket starts on a boundary', () => {
      feed(range(0, 10));
      expect(warning).not.toHaveBeenCalled();
    });
  });

  describe('invalid buckets', () => {
    it.each`
      case               | bucket
      ${'misses a pair'} | ${bucketAt(0, [BTC])}
      ${'is empty'}      | ${new Map()}
      ${'mixes minutes'} | ${new Map([[BTC, candleAt(BTC, 0)], [ETH, candleAt(ETH, 1)]])}
    `('should throw a GekkoError when the bucket $case', ({ bucket }) => {
      expect(() => new CandleBucketBatcher([BTC, ETH], 5).addBucket(bucket)).toThrow(GekkoError);
    });

    it.each`
      case               | bucket                                                         | message
      ${'misses a pair'} | ${bucketAt(0, [BTC])}                                          | ${`Missing ETH/USDT candle in the bucket of ${toISOString(at(0))}: every watched pair needs a candle every minute`}
      ${'is empty'}      | ${new Map()}                                                   | ${'Missing BTC/USDT candle in the bucket of Unknown Date: every watched pair needs a candle every minute'}
      ${'mixes minutes'} | ${new Map([[BTC, candleAt(BTC, 0)], [ETH, candleAt(ETH, 1)]])} | ${`The ETH/USDT candle starts at ${toISOString(at(1))} instead of ${toISOString(at(0))} like the rest of its bucket`}
    `('should name the pair and the minute when the bucket $case', ({ bucket, message }) => {
      expect(() => new CandleBucketBatcher([BTC, ETH], 5).addBucket(bucket)).toThrow(`[CORE] ${message}`);
    });

    it.each`
      case                                              | minutes
      ${'skips a minute'}                               | ${[0, 2]}
      ${'repeats a minute'}                             | ${[0, 1, 1]}
      ${'goes back in time'}                            | ${[0, 1, 0]}
      ${'starts less than a minute after the last one'} | ${[0, 0.5]}
    `('should throw when the next bucket $case', ({ minutes }) => {
      const last = minutes.at(-1);
      const previous = minutes.at(-2);
      expect(() => feed(minutes)).toThrow(
        `Received the bucket of ${toISOString(at(last))} after the one of ${toISOString(at(previous))}: buckets must follow each other minute by minute`,
      );
    });
  });
});
