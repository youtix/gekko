import { ONE_MINUTE } from '@constants/time.const';
import { GekkoError } from '@errors/gekko.error';
import { CandleBucket } from '@models/event.types';
import { TradingPair } from '@models/utility.types';
import { getBucketTimestamp } from '@utils/candle/candle.utils';
import { toISOString } from '@utils/date/date.utils';
import { CandleSize } from './candleBatcher.types';
import { FastCandleBatcher, isTimeframeCandleClose } from './fastCandleBatcher';

/**
 * Batches 1-minute CandleBuckets into higher timeframe CandleBuckets.
 * Every bucket must hold a candle of every pair, all starting on the same minute, one minute after the previous bucket.
 */
export class CandleBucketBatcher {
  private readonly batchers: Map<TradingPair, FastCandleBatcher>;
  private readonly candleSize: CandleSize;
  private lastTimestamp?: EpochTimeStamp;

  constructor(pairs: TradingPair[], candleSize: CandleSize) {
    if (!pairs.length) throw new GekkoError('core', 'CandleBucketBatcher needs at least one pair');
    this.candleSize = candleSize;
    this.batchers = new Map(pairs.map(pair => [pair, new FastCandleBatcher(candleSize)]));
  }

  /**
   * Process a 1-minute candle bucket.
   * @param bucket - Must contain candles for ALL registered pairs; candles of other pairs are ignored
   * @returns Completed timeframe bucket, or undefined if not yet ready
   * @throws GekkoError if the bucket misses a pair, mixes minutes or does not follow the previous bucket
   */
  addBucket(bucket: CandleBucket): CandleBucket | undefined {
    const timestamp = this.checkBucket(bucket);
    for (const [pair, batcher] of this.batchers) batcher.accumulate(bucket.get(pair)!);

    // Every candle of the bucket starts on the same minute, so they all close a timeframe candle or none does
    if (!isTimeframeCandleClose(this.candleSize, timestamp)) return undefined;

    const completedBucket: CandleBucket = new Map();
    for (const [pair, batcher] of this.batchers) {
      const candle = batcher.flush();
      if (candle) completedBucket.set(pair, candle);
    }
    // Empty when the timeframe candle closing now started before the first boundary, so was skipped
    return completedBucket.size === this.batchers.size ? completedBucket : undefined;
  }

  /**
   * Get the number of registered trading pairs.
   */
  get pairCount(): number {
    return this.batchers.size;
  }

  /** Checks that the bucket can be batched (upstream must guarantee it, hence the errors) and returns its minute. */
  private checkBucket(bucket: CandleBucket): EpochTimeStamp {
    let timestamp: EpochTimeStamp | undefined;
    for (const pair of this.batchers.keys()) {
      const candle = bucket.get(pair);
      if (!candle) {
        throw new GekkoError(
          'core',
          `Missing ${pair} candle in the bucket of ${toISOString(getBucketTimestamp(bucket))}: every watched pair needs a candle every minute`,
        );
      }
      timestamp ??= candle.start;
      if (candle.start !== timestamp) {
        throw new GekkoError(
          'core',
          `The ${pair} candle starts at ${toISOString(candle.start)} instead of ${toISOString(timestamp)} like the rest of its bucket`,
        );
      }
    }

    // Exactly one minute after the previous bucket: the candles start on whole minutes, and the gap filler has made up any minute
    // missing. The check was a window, after the previous bucket and up to the next minute of the calendar, for the e2e flows that ran
    // on a minute of 50 ms: a bucket starting anywhere in it went through.
    if (this.lastTimestamp !== undefined && timestamp! !== this.lastTimestamp + ONE_MINUTE) {
      throw new GekkoError(
        'core',
        `Received the bucket of ${toISOString(timestamp)} after the one of ${toISOString(this.lastTimestamp)}: buckets must follow each other minute by minute`,
      );
    }
    this.lastTimestamp = timestamp;
    return timestamp!;
  }
}
