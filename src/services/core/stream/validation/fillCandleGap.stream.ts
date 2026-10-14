import { ONE_MINUTE } from '@constants/time.const';
import { GekkoError } from '@errors/gekko.error';
import { Candle } from '@models/candle.types';
import { CandleBucket } from '@models/event.types';
import { TradingPair } from '@models/utility.types';
import { warning } from '@services/logger';
import { createEmptyCandle, getBucketTimestamp } from '@utils/candle/candle.utils';
import { toISOString } from '@utils/date/date.utils';
import { pluralize } from '@utils/string/string.utils';
import { Transform, TransformCallback } from 'node:stream';
import { MAX_GAP_FILL_MINUTES } from './fillCandleGap.const';

export type FillCandleGapOptions = {
  /**
   * Drop the leading buckets until every pair has had a candle, instead of pushing them without the pairs never seen so far (a
   * missing pair is filled from its last candle, which such a pair lacks, and a later candle cannot fill an earlier minute).
   * The realtime pipeline needs it (the TradingAdvisor batcher refuses an incomplete bucket); the importer does not (each pair
   * is stored on its own, so its leading minutes are worth keeping).
   */
  dropIncompleteLeadingBuckets?: boolean;
};

export class FillCandleGapStream extends Transform {
  private readonly pairs: TradingPair[];
  private readonly dropIncompleteLeadingBuckets: boolean;
  private lastKnownCandles = new Map<TradingPair, Candle>();
  private lastTimestamp: number | null = null;
  private droppedLeadingMinutes = 0;
  /** First minute of each partial gap still open, by pair: warned about when it opens and when it closes, not every minute */
  private partialGapStarts = new Map<TradingPair, EpochTimeStamp>();

  constructor(pairs: TradingPair[], options: FillCandleGapOptions = {}) {
    super({ objectMode: true });
    this.pairs = pairs;
    this.dropIncompleteLeadingBuckets = options.dropIncompleteLeadingBuckets ?? false;
  }

  _transform(bucket: CandleBucket, _: BufferEncoding, next: TransformCallback) {
    try {
      // 1. Determine current timestamp from any available candle in the bucket
      const currentTimestamp = getBucketTimestamp(bucket);
      if (currentTimestamp === undefined) return next();

      // 2. Ignore a duplicate or out-of-order bucket: pushing it would move the clock back and refill minutes already pushed
      if (this.lastTimestamp !== null && currentTimestamp <= this.lastTimestamp) {
        warning(
          'stream',
          `Ignoring the bucket of ${toISOString(currentTimestamp)}: it does not follow the last bucket pushed (${toISOString(this.lastTimestamp)})`,
        );
        return next();
      }

      // 3. Drop the leading buckets that miss a pair never seen so far, if asked to
      if (this.dropIncompleteLeadingBuckets && this.isIncompleteLeadingBucket(bucket, currentTimestamp)) return next();

      // 4. Handle Total Gaps (Time jumps). Once a bucket has been pushed with dropIncompleteLeadingBuckets, every pair has a
      // last known candle, so a synthetic bucket is always complete.
      if (this.lastTimestamp !== null) {
        const expectedTimestamp = this.lastTimestamp + ONE_MINUTE;
        if (currentTimestamp > expectedTimestamp) {
          const gapMinutes = (currentTimestamp - expectedTimestamp) / ONE_MINUTE;
          if (gapMinutes > MAX_GAP_FILL_MINUTES) {
            throw new GekkoError(
              'stream',
              [
                `No candle from ${toISOString(expectedTimestamp)} to ${toISOString(currentTimestamp - ONE_MINUTE)} (${gapMinutes} minutes):`,
                `refusing to fill more than ${MAX_GAP_FILL_MINUTES} minutes with empty candles`,
              ].join(' '),
            );
          }
          warning(
            'stream',
            `Total gap detected: filling ${gapMinutes} ${pluralize('minute', gapMinutes)} for all assets from ${toISOString(expectedTimestamp)}`,
          );

          let fillTimestamp = expectedTimestamp;
          while (fillTimestamp < currentTimestamp) {
            const filledBucket: CandleBucket = new Map();

            for (const pair of this.pairs) {
              const lastCandle = this.lastKnownCandles.get(pair);
              if (lastCandle) {
                const syntheticCandle = createEmptyCandle(lastCandle);
                syntheticCandle.start = fillTimestamp;

                filledBucket.set(pair, syntheticCandle);
                this.lastKnownCandles.set(pair, syntheticCandle);
              }
            }

            if (filledBucket.size > 0) {
              this.push(filledBucket);
            }
            fillTimestamp += ONE_MINUTE;
          }
        }
      }

      // 5. Process Current Bucket (Handle Partial Gaps)
      const completeBucket: CandleBucket = new Map();
      for (const pair of this.pairs) {
        const candle = bucket.get(pair);

        if (candle) {
          this.closePartialGap(pair, currentTimestamp);
          this.lastKnownCandles.set(pair, candle);
          completeBucket.set(pair, candle);
        } else {
          const lastCandle = this.lastKnownCandles.get(pair);
          if (lastCandle) {
            this.openPartialGap(pair, currentTimestamp);
            const syntheticCandle = createEmptyCandle(lastCandle);
            syntheticCandle.start = currentTimestamp;

            this.lastKnownCandles.set(pair, syntheticCandle);
            completeBucket.set(pair, syntheticCandle);
          }
        }
      }

      this.lastTimestamp = currentTimestamp;
      this.push(completeBucket);
      next();
    } catch (error) {
      next(error as Error);
    }
  }

  private openPartialGap(pair: TradingPair, timestamp: EpochTimeStamp) {
    if (this.partialGapStarts.has(pair)) return;
    this.partialGapStarts.set(pair, timestamp);
    warning('stream', `Partial gap: no ${pair} candle at ${toISOString(timestamp)}, filling with empty candles until it comes back`);
  }

  private closePartialGap(pair: TradingPair, timestamp: EpochTimeStamp) {
    const gapStart = this.partialGapStarts.get(pair);
    if (gapStart === undefined) return;
    this.partialGapStarts.delete(pair);
    const minutes = (timestamp - gapStart) / ONE_MINUTE;
    warning(
      'stream',
      `Partial gap closed: ${pair} is back at ${toISOString(timestamp)}, ${minutes} ${pluralize('minute', minutes)} filled with empty candles from ${toISOString(gapStart)}`,
    );
  }

  /**
   * Tells whether a bucket misses a pair that has never had a candle. Such a bucket can only come before the first pushed one,
   * since every pair has a last known candle from then on. The candles it does hold still count as seen, so a pair seen in a
   * dropped bucket can be filled later on.
   *
   * Only the first drop is warned about, then the first pushed minute sums the drops up: a pair listed during a long warmup window
   * has no candle in thousands of its minutes, and a warning each would flood the log and evict the other warnings from the buffer
   * that Supervision forwards to Telegram.
   */
  private isIncompleteLeadingBucket(bucket: CandleBucket, timestamp: EpochTimeStamp) {
    const neverSeenPairs = this.pairs.filter(pair => !bucket.has(pair) && !this.lastKnownCandles.has(pair));

    if (neverSeenPairs.length) {
      if (this.droppedLeadingMinutes === 0) {
        for (const pair of neverSeenPairs) {
          warning('stream', `No ${pair} candle at ${toISOString(timestamp)}: dropping the leading buckets until every pair has a candle`);
        }
      }
      for (const pair of this.pairs) {
        const candle = bucket.get(pair);
        if (candle) this.lastKnownCandles.set(pair, candle);
      }
      this.droppedLeadingMinutes++;
      return true;
    }

    if (this.droppedLeadingMinutes > 0) {
      warning(
        'stream',
        [
          `Every pair has had a candle by ${toISOString(timestamp)}, the first minute pushed:`,
          `${this.droppedLeadingMinutes} leading ${pluralize('minute', this.droppedLeadingMinutes)} dropped, so the warmup will end later than planned`,
        ].join(' '),
      );
      this.droppedLeadingMinutes = 0;
    }
    return false;
  }
}
