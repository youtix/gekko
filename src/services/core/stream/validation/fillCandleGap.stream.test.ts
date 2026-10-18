import { ONE_MINUTE } from '@constants/time.const';
import { Candle } from '@models/candle.types';
import { CandleBucket } from '@models/event.types';
import { TradingPair } from '@models/utility.types';
import { warning } from '@services/logger';
import { toISOString } from '@utils/date/date.utils';
import { range } from 'lodash-es';
import { describe, expect, it, vi } from 'vitest';
import { MAX_GAP_FILL_MINUTES } from './fillCandleGap.const';
import { FillCandleGapStream } from './fillCandleGap.stream';
import { FillCandleGapOptions } from './fillCandleGap.types';

vi.mock('@services/logger', () => ({ warning: vi.fn() }));

const ETH: TradingPair = 'ETH/USDT';
const BTC: TradingPair = 'BTC/USDT';
const T0 = Date.UTC(2024, 0, 1);
const at = (minute: number) => T0 + minute * ONE_MINUTE;

const candleAt = (minute: number): Candle => ({ start: at(minute), open: 10, high: 12, low: 9, close: 11 + minute, volume: 100 });

/** A bucket of `minute` holding a real candle of each given pair */
const bucketAt = (minute: number, ...pairs: TradingPair[]): CandleBucket => new Map(pairs.map(pair => [pair, candleAt(minute)]));

/** Describes each emitted bucket as its candles: base asset, minute, and `~` for a synthetic candle, e.g. 'ETH3 BTC3~' */
const describeBuckets = (buckets: CandleBucket[]) =>
  buckets.map(bucket =>
    [...bucket].map(([pair, { start, synthetic }]) => `${pair.split('/')[0]}${(start - T0) / ONE_MINUTE}${synthetic ? '~' : ''}`).join(' '),
  );

/** The messages logged as warnings so far */
const warnings = () => vi.mocked(warning).mock.calls.map(([, message]) => String(message));

const run = async (buckets: CandleBucket[], options?: FillCandleGapOptions, pairs: TradingPair[] = [ETH, BTC]) => {
  const stream = new FillCandleGapStream(pairs, options);
  for (const bucket of buckets) stream.write(bucket);
  stream.end();
  return (await stream.toArray()) as CandleBucket[];
};

const throwUnreadable = () => {
  throw new Error('unreadable');
};

/** The `hasEndedBefore` of a stream whose `pair` ended with its candle of `lastMinute` */
const endedAt =
  (pair: TradingPair, lastMinute: number): FillCandleGapOptions['hasEndedBefore'] =>
  (asked, minute) =>
    asked === pair && at(lastMinute) < minute;

/** The refusal of a gap of `pair` from the minute `from` to the minute `to`, both missing */
const refusal = (pair: TradingPair, from: number, to: number) =>
  `[STREAM] No ${pair} candle from ${toISOString(at(from))} to ${toISOString(at(to))} (${to - from + 1} minutes): refusing to fill more than ${MAX_GAP_FILL_MINUTES} minutes with empty candles`;

describe('FillCandleGapStream', () => {
  describe('complete buckets', () => {
    it('should push complete consecutive buckets as they are', async () => {
      const buckets = [bucketAt(0, ETH, BTC), bucketAt(1, ETH, BTC)];
      expect(await run(buckets)).toEqual(buckets);
    });

    it('should not warn about complete consecutive buckets', async () => {
      await run([bucketAt(0, ETH, BTC), bucketAt(1, ETH, BTC)]);
      expect(warning).not.toHaveBeenCalled();
    });

    it('should push the pairs in the order the stream was built with', async () => {
      const buckets = await run([bucketAt(0, BTC, ETH)]);
      expect(describeBuckets(buckets)).toEqual(['ETH0 BTC0']);
    });

    it('should leave out a pair the stream was not built with', async () => {
      const buckets = await run([bucketAt(0, ETH, 'LTC/USDT', BTC)]);
      expect(describeBuckets(buckets)).toEqual(['ETH0 BTC0']);
    });

    it('should drop an empty bucket', async () => {
      const buckets = await run([new Map(), bucketAt(0, ETH, BTC)]);
      expect(describeBuckets(buckets)).toEqual(['ETH0 BTC0']);
    });
  });

  describe('leading buckets missing a pair never seen', () => {
    it.each`
      dropIncompleteLeadingBuckets | input                                                               | expected
      ${undefined}                 | ${[bucketAt(0, ETH), bucketAt(1, ETH), bucketAt(2, ETH, BTC)]}      | ${['ETH0', 'ETH1', 'ETH2 BTC2']}
      ${false}                     | ${[bucketAt(0, ETH), bucketAt(1, ETH), bucketAt(2, ETH, BTC)]}      | ${['ETH0', 'ETH1', 'ETH2 BTC2']}
      ${true}                      | ${[bucketAt(0, ETH), bucketAt(1, ETH), bucketAt(2, ETH, BTC)]}      | ${['ETH2 BTC2']}
      ${true}                      | ${[bucketAt(0, ETH), bucketAt(1, BTC), bucketAt(2, ETH, BTC)]}      | ${['ETH1~ BTC1', 'ETH2 BTC2']}
      ${true}                      | ${[bucketAt(0, ETH), bucketAt(1, ETH, BTC), bucketAt(4, ETH, BTC)]} | ${['ETH1 BTC1', 'ETH2~ BTC2~', 'ETH3~ BTC3~', 'ETH4 BTC4']}
      ${true}                      | ${[bucketAt(0, ETH, BTC), bucketAt(1, ETH)]}                        | ${['ETH0 BTC0', 'ETH1 BTC1~']}
    `(
      'should push $expected with dropIncompleteLeadingBuckets $dropIncompleteLeadingBuckets',
      async ({ dropIncompleteLeadingBuckets, input, expected }) => {
        const buckets = await run(input, { dropIncompleteLeadingBuckets });
        expect(describeBuckets(buckets)).toEqual(expected);
      },
    );

    it('should warn once per pair never seen, then once when every pair has had a candle, when dropping leading buckets', async () => {
      await run([bucketAt(0, ETH), bucketAt(1, ETH), bucketAt(2, ETH), bucketAt(3, ETH, BTC)], { dropIncompleteLeadingBuckets: true }, [
        ETH,
        BTC,
        'SOL/USDT',
      ]);
      expect(warnings()).toEqual([
        `No BTC/USDT candle at ${toISOString(at(0))}: dropping the leading buckets until every pair has a candle`,
        `No SOL/USDT candle at ${toISOString(at(0))}: dropping the leading buckets until every pair has a candle`,
      ]);
    });

    // A pair listed during a long warmup window misses thousands of buckets: the warnings do not grow with them
    it.each`
      dropped    | input                                                                                                   | count
      ${'none'}  | ${[bucketAt(0, ETH, BTC), bucketAt(1, ETH, BTC)]}                                                       | ${0}
      ${'one'}   | ${[bucketAt(0, ETH), bucketAt(1, ETH, BTC), bucketAt(2, ETH, BTC)]}                                     | ${2}
      ${'three'} | ${[bucketAt(0, ETH), bucketAt(1, ETH), bucketAt(2, ETH), bucketAt(3, ETH, BTC), bucketAt(4, ETH, BTC)]} | ${2}
    `('should warn $count time(s) about the leading buckets with $dropped dropped', async ({ input, count }) => {
      await run(input, { dropIncompleteLeadingBuckets: true });
      expect(warning).toHaveBeenCalledTimes(count);
    });

    it.each`
      first | input                                                          | dropped
      ${1}  | ${[bucketAt(0, ETH), bucketAt(1, ETH, BTC)]}                   | ${'1 leading minute dropped'}
      ${2}  | ${[bucketAt(0, ETH), bucketAt(1, ETH), bucketAt(2, ETH, BTC)]} | ${'2 leading minutes dropped'}
    `('should tell, once every pair has had a candle, that $dropped', async ({ first, input, dropped }) => {
      await run(input, { dropIncompleteLeadingBuckets: true });
      expect(warning).toHaveBeenLastCalledWith(
        'stream',
        `Every pair has had a candle by ${toISOString(at(first))}, the first minute pushed: ${dropped}, so the warmup will end later than planned`,
      );
    });

    it('should not warn about the leading buckets when they are pushed', async () => {
      await run([bucketAt(0, ETH), bucketAt(1, ETH, BTC)]);
      expect(warning).not.toHaveBeenCalled();
    });
  });

  describe('partial gaps', () => {
    it('should fill a pair missing from a bucket with an empty candle', async () => {
      const buckets = await run([bucketAt(0, ETH, BTC), bucketAt(1, ETH), bucketAt(2, BTC), bucketAt(3, ETH, BTC)]);
      expect(describeBuckets(buckets)).toEqual(['ETH0 BTC0', 'ETH1 BTC1~', 'ETH2~ BTC2', 'ETH3 BTC3']);
    });

    it('should fill a pair from its last known candle', async () => {
      const [, filled] = await run([bucketAt(0, ETH, BTC), bucketAt(1, ETH)]);
      expect(filled.get(BTC)).toEqual({ start: at(1), open: 11, high: 11, low: 11, close: 11, volume: 0, synthetic: true });
    });
    it('should warn once when a partial gap opens and once when it closes, however long it lasts', async () => {
      await run([bucketAt(0, ETH, BTC), bucketAt(1, ETH), bucketAt(2, ETH), bucketAt(3, ETH), bucketAt(4, ETH, BTC)]);
      expect(warnings()).toEqual([
        `Partial gap: no BTC/USDT candle at ${toISOString(at(1))}, filling with empty candles until it comes back`,
        `Partial gap closed: BTC/USDT is back at ${toISOString(at(4))}, 3 minutes filled with empty candles from ${toISOString(at(1))}`,
      ]);
    });

    it.each`
      back | filled
      ${2} | ${'1 minute filled'}
      ${4} | ${'3 minutes filled'}
    `('should tell, when a partial gap closes, that $filled', async ({ back, filled }) => {
      await run([bucketAt(0, ETH, BTC), ...range(1, back).map(minute => bucketAt(minute, ETH)), bucketAt(back, ETH, BTC)]);
      expect(warning).toHaveBeenLastCalledWith(
        'stream',
        `Partial gap closed: BTC/USDT is back at ${toISOString(at(back))}, ${filled} with empty candles from ${toISOString(at(1))}`,
      );
    });

    it('should count the minutes of a total gap in the partial gap it interrupts', async () => {
      await run([bucketAt(0, ETH, BTC), bucketAt(1, ETH), bucketAt(4, ETH, BTC)]);
      expect(warning).toHaveBeenLastCalledWith(
        'stream',
        `Partial gap closed: BTC/USDT is back at ${toISOString(at(4))}, 3 minutes filled with empty candles from ${toISOString(at(1))}`,
      );
    });

    it('should warn about the partial gaps of each pair separately', async () => {
      await run([bucketAt(0, ETH, BTC), bucketAt(1, ETH), bucketAt(2, BTC), bucketAt(3, ETH, BTC)]);
      expect(warnings().map(message => message.split(',')[0])).toEqual([
        `Partial gap: no BTC/USDT candle at ${toISOString(at(1))}`,
        `Partial gap: no ETH/USDT candle at ${toISOString(at(2))}`,
        `Partial gap closed: BTC/USDT is back at ${toISOString(at(2))}`,
        `Partial gap closed: ETH/USDT is back at ${toISOString(at(3))}`,
      ]);
    });

    it(`should fill a partial gap of ${MAX_GAP_FILL_MINUTES} minutes`, async () => {
      await run([
        bucketAt(0, ETH, BTC),
        ...range(1, MAX_GAP_FILL_MINUTES + 1).map(minute => bucketAt(minute, ETH)),
        bucketAt(MAX_GAP_FILL_MINUTES + 1, ETH, BTC),
      ]);
      expect(warning).toHaveBeenLastCalledWith(
        'stream',
        `Partial gap closed: BTC/USDT is back at ${toISOString(at(MAX_GAP_FILL_MINUTES + 1))}, ${MAX_GAP_FILL_MINUTES} minutes filled with empty candles from ${toISOString(at(1))}`,
      );
    });

    // A pair suspended for weeks while another traded was filled minute after minute to the end, a total gap only being bounded
    it(`should refuse to fill a partial gap longer than ${MAX_GAP_FILL_MINUTES} minutes, naming the pair`, async () => {
      await expect(
        run([bucketAt(0, ETH, BTC), ...range(1, MAX_GAP_FILL_MINUTES + 2).map(minute => bucketAt(minute, ETH))]),
      ).rejects.toThrow(refusal(BTC, 1, MAX_GAP_FILL_MINUTES + 1));
    });

    it.each`
      case                                  | input
      ${'a total gap that lengthens it'}    | ${[bucketAt(0, ETH, BTC), ...range(1, 6).map(minute => bucketAt(minute, ETH)), bucketAt(MAX_GAP_FILL_MINUTES + 2, ETH, BTC)]}
      ${'a total gap of the most it fills'} | ${[bucketAt(0, ETH, BTC), bucketAt(MAX_GAP_FILL_MINUTES + 1, ETH)]}
    `(`should refuse a partial gap longer than ${MAX_GAP_FILL_MINUTES} minutes with $case`, async ({ input }) => {
      await expect(run(input)).rejects.toThrow(refusal(BTC, 1, MAX_GAP_FILL_MINUTES + 1));
    });

    // The buckets written before the refusal still come through: read from the clock the refusal left, each made up a total gap
    it('should push and warn about nothing more once it refused a gap', async () => {
      const failure = await run([bucketAt(0, ETH, BTC), ...range(1, MAX_GAP_FILL_MINUTES + 4).map(minute => bucketAt(minute, ETH))]).then(
        () => undefined,
        (error: Error) => error.message,
      );
      expect({ failure, warnings: warnings() }).toEqual({
        failure: refusal(BTC, 1, MAX_GAP_FILL_MINUTES + 1),
        warnings: [`Partial gap: no BTC/USDT candle at ${toISOString(at(1))}, filling with empty candles until it comes back`],
      });
    });

    it.each`
      last | filled
      ${1} | ${'1 minute filled'}
      ${3} | ${'3 minutes filled'}
    `('should tell, when the stream ends with a partial gap open, that $filled', async ({ last, filled }) => {
      await run([bucketAt(0, ETH, BTC), ...range(1, last + 1).map(minute => bucketAt(minute, ETH))]);
      expect(warning).toHaveBeenLastCalledWith(
        'stream',
        `Partial gap still open at the end of the run: no BTC/USDT candle since ${toISOString(at(1))}, ${filled} with empty candles`,
      );
    });

    it('should tell about each partial gap still open when the stream ends', async () => {
      await run([bucketAt(0, ETH, BTC, 'SOL/USDT'), bucketAt(1, ETH, 'SOL/USDT'), bucketAt(2, ETH)], undefined, [ETH, BTC, 'SOL/USDT']);
      expect(warnings().slice(-2)).toEqual([
        `Partial gap still open at the end of the run: no BTC/USDT candle since ${toISOString(at(1))}, 2 minutes filled with empty candles`,
        `Partial gap still open at the end of the run: no SOL/USDT candle since ${toISOString(at(2))}, 1 minute filled with empty candles`,
      ]);
    });
  });

  describe('pairs whose stream has ended', () => {
    it.each`
      case                                          | input                                                                                 | hasEndedBefore     | expected
      ${'after its last candle'}                    | ${[bucketAt(0, ETH, BTC), bucketAt(1, ETH, BTC), bucketAt(2, BTC), bucketAt(3, BTC)]} | ${endedAt(ETH, 1)} | ${['ETH0 BTC0', 'ETH1 BTC1', 'BTC2', 'BTC3']}
      ${'through a total gap'}                      | ${[bucketAt(0, ETH, BTC), bucketAt(1, BTC), bucketAt(4, BTC)]}                        | ${endedAt(ETH, 0)} | ${['ETH0 BTC0', 'BTC1', 'BTC2~', 'BTC3~', 'BTC4']}
      ${'but filled where its last candles follow'} | ${[bucketAt(0, ETH, BTC), bucketAt(1, BTC), bucketAt(2, ETH, BTC), bucketAt(3, BTC)]} | ${endedAt(ETH, 2)} | ${['ETH0 BTC0', 'ETH1~ BTC1', 'ETH2 BTC2', 'BTC3']}
    `('should leave out a pair whose stream ended, $case: $expected', async ({ input, hasEndedBefore, expected }) => {
      const buckets = await run(input, { hasEndedBefore });
      expect(describeBuckets(buckets)).toEqual(expected);
    });

    it('should not warn about a pair whose stream ended', async () => {
      await run([bucketAt(0, ETH, BTC), bucketAt(1, BTC), bucketAt(2, BTC)], { hasEndedBefore: endedAt(ETH, 0) });
      expect(warning).not.toHaveBeenCalled();
    });

    // The history of a delisted pair ended early, and the pair was filled with flat candles to the end of a two-pair import
    it(`should push BTC${MAX_GAP_FILL_MINUTES + 1} alone, ${MAX_GAP_FILL_MINUTES + 1} minutes after ETH's stream ended, neither filling ETH nor refusing`, async () => {
      const buckets = await run([bucketAt(0, ETH, BTC), ...range(1, MAX_GAP_FILL_MINUTES + 2).map(minute => bucketAt(minute, BTC))], {
        hasEndedBefore: endedAt(ETH, 0),
      });
      expect(describeBuckets(buckets).at(-1)).toBe(`BTC${MAX_GAP_FILL_MINUTES + 1}`);
    });
  });

  describe('total gaps', () => {
    it('should fill every missing minute for every pair', async () => {
      const buckets = await run([bucketAt(0, ETH, BTC), bucketAt(3, ETH, BTC)]);
      expect(describeBuckets(buckets)).toEqual(['ETH0 BTC0', 'ETH1~ BTC1~', 'ETH2~ BTC2~', 'ETH3 BTC3']);
    });

    it('should fill only the pairs already seen', async () => {
      const buckets = await run([bucketAt(0, ETH), bucketAt(2, ETH, BTC)]);
      expect(describeBuckets(buckets)).toEqual(['ETH0', 'ETH1~', 'ETH2 BTC2']);
    });

    it('should push no synthetic bucket when no pair was ever seen', async () => {
      const buckets = await run([bucketAt(0, 'LTC/USDT'), bucketAt(2, ETH, BTC)]);
      expect(describeBuckets(buckets)).toEqual(['', 'ETH2 BTC2']);
    });

    it('should fill a total gap that follows a partial gap from the filled candles', async () => {
      const buckets = await run([bucketAt(0, ETH, BTC), bucketAt(1, ETH), bucketAt(3, ETH, BTC)]);
      expect(describeBuckets(buckets)).toEqual(['ETH0 BTC0', 'ETH1 BTC1~', 'ETH2~ BTC2~', 'ETH3 BTC3']);
    });
    it.each`
      next | filling
      ${2} | ${'1 minute'}
      ${4} | ${'3 minutes'}
    `('should warn once about a total gap, filling $filling', async ({ next, filling }) => {
      await run([bucketAt(0, ETH, BTC), bucketAt(next, ETH, BTC)]);
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        'stream',
        `Total gap detected: filling ${filling} for all assets from ${toISOString(at(1))}`,
      );
    });

    it(`should fill a total gap of ${MAX_GAP_FILL_MINUTES} minutes`, async () => {
      const buckets = await run([bucketAt(0, ETH, BTC), bucketAt(MAX_GAP_FILL_MINUTES + 1, ETH, BTC)]);
      expect(buckets).toHaveLength(MAX_GAP_FILL_MINUTES + 2);
    });

    it(`should refuse to fill a total gap longer than ${MAX_GAP_FILL_MINUTES} minutes`, async () => {
      await expect(run([bucketAt(0, ETH, BTC), bucketAt(MAX_GAP_FILL_MINUTES + 2, ETH, BTC)])).rejects.toThrow(
        `No candle from ${toISOString(at(1))} to ${toISOString(at(MAX_GAP_FILL_MINUTES + 1))} (${MAX_GAP_FILL_MINUTES + 1} minutes): refusing to fill more than ${MAX_GAP_FILL_MINUTES} minutes with empty candles`,
      );
    });
  });

  describe('buckets that do not follow the last one', () => {
    it.each`
      case              | input                                                                                           | expected
      ${'duplicate'}    | ${[bucketAt(0, ETH, BTC), bucketAt(1, ETH, BTC), bucketAt(1, ETH, BTC), bucketAt(2, ETH, BTC)]} | ${['ETH0 BTC0', 'ETH1 BTC1', 'ETH2 BTC2']}
      ${'out-of-order'} | ${[bucketAt(0, ETH, BTC), bucketAt(2, ETH, BTC), bucketAt(1, ETH, BTC), bucketAt(3, ETH, BTC)]} | ${['ETH0 BTC0', 'ETH1~ BTC1~', 'ETH2 BTC2', 'ETH3 BTC3']}
    `('should ignore a $case bucket without moving the clock back', async ({ input, expected }) => {
      const buckets = await run(input);
      expect(describeBuckets(buckets)).toEqual(expected);
    });

    it('should warn about an ignored bucket', async () => {
      await run([bucketAt(0, ETH, BTC), bucketAt(1, ETH, BTC), bucketAt(0, ETH, BTC)]);
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        'stream',
        `Ignoring the bucket of ${toISOString(at(0))}: it does not follow the last bucket pushed (${toISOString(at(1))})`,
      );
    });
  });

  describe('errors', () => {
    it('should forward an error thrown while reading a bucket', async () => {
      const unreadable: CandleBucket = new Map([[ETH, Object.defineProperty(candleAt(0), 'start', { get: throwUnreadable })]]);
      await expect(run([unreadable])).rejects.toThrow('unreadable');
    });
  });
});
