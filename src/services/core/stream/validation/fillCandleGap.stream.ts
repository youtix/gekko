import { ONE_MINUTE } from '@constants/time.const';
import { GekkoError } from '@errors/gekko.error';
import { createEmptyCandle, getBucketTimestamp } from '@helpers/candle/candle.helper';
import { Candle } from '@models/candle.types';
import { CandleBucket } from '@models/event.types';
import { TradingPair } from '@models/utility.types';
import { warning } from '@services/logger';
import { toISOString } from '@utils/date/date.utils';
import { pluralize } from '@utils/string/string.utils';
import { Transform, TransformCallback } from 'node:stream';
import { MAX_GAP_FILL_MINUTES } from './fillCandleGap.const';
import { FillCandleGapOptions } from './fillCandleGap.types';

export class FillCandleGapStream extends Transform {
  private readonly pairs: TradingPair[];
  private readonly dropIncompleteLeadingBuckets: boolean;
  private readonly hasEndedBefore: (pair: TradingPair, minute: EpochTimeStamp) => boolean;
  /**
   * The last candle received of each pair, never one made up: an empty candle carries its close on, and its start tells how long
   * the pair has gone without a candle, however the minutes since were filled
   */
  private lastCandles = new Map<TradingPair, Candle>();
  private lastTimestamp: number | null = null;
  private droppedLeadingMinutes = 0;
  /** First minute of each partial gap still open, by pair: warned about when it opens and when it closes, not every minute */
  private partialGapStarts = new Map<TradingPair, EpochTimeStamp>();
  /**
   * Set once a bucket has failed. The writes queued before the failure still reach _transform, in Node as in Bun, and read from the
   * clock the failure left on the minute before the refused bucket, each of them would make up a total gap of its own and warn.
   */
  private failed = false;

  constructor(pairs: TradingPair[], options: FillCandleGapOptions = {}) {
    super({ objectMode: true });
    this.pairs = pairs;
    this.dropIncompleteLeadingBuckets = options.dropIncompleteLeadingBuckets ?? false;
    this.hasEndedBefore = options.hasEndedBefore ?? (() => false);
  }

  _transform(bucket: CandleBucket, _: BufferEncoding, next: TransformCallback) {
    if (this.failed) return next();
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

      // 4. Refuse a gap too long to fill before anything is pushed for this bucket
      const totalGapStart =
        this.lastTimestamp !== null && currentTimestamp > this.lastTimestamp + ONE_MINUTE ? this.lastTimestamp + ONE_MINUTE : undefined;
      if (totalGapStart !== undefined) this.checkTotalGap(totalGapStart, currentTimestamp);
      this.checkFilledMinutes(bucket, currentTimestamp, totalGapStart);

      // 5. Handle Total Gaps (Time jumps). Once a bucket has been pushed with dropIncompleteLeadingBuckets, every pair has a
      // last candle, so a synthetic bucket is complete but for the pairs whose stream has ended.
      if (totalGapStart !== undefined) this.fillTotalGap(totalGapStart, currentTimestamp);

      // 6. Process Current Bucket (Handle Partial Gaps)
      const completeBucket: CandleBucket = new Map();
      for (const pair of this.pairs) {
        const candle = bucket.get(pair);

        if (candle) {
          this.closePartialGap(pair, currentTimestamp);
          this.lastCandles.set(pair, candle);
          completeBucket.set(pair, candle);
        } else if (this.isFilled(pair, currentTimestamp)) {
          this.openPartialGap(pair, currentTimestamp);
          completeBucket.set(pair, this.createFilledCandle(pair, currentTimestamp));
        }
      }

      this.lastTimestamp = currentTimestamp;
      this.push(completeBucket);
      next();
    } catch (error) {
      this.failed = true;
      next(error as Error);
    }
  }

  /** A partial gap still open when the stream ends was announced as filled "until it comes back": what it came to was never said */
  _flush(done: TransformCallback) {
    for (const [pair, gapStart] of this.partialGapStarts) {
      const minutes = (this.lastTimestamp! - gapStart) / ONE_MINUTE + 1;
      warning(
        'stream',
        `Partial gap still open at the end of the run: no ${pair} candle since ${toISOString(gapStart)}, ${minutes} ${pluralize('minute', minutes)} filled with empty candles`,
      );
    }
    done();
  }

  /** Whether a pair missing from the minute is filled: it has had a candle, and its stream has not ended before the minute */
  private isFilled(pair: TradingPair, minute: EpochTimeStamp) {
    return this.lastCandles.has(pair) && !this.hasEndedBefore(pair, minute);
  }

  private createFilledCandle(pair: TradingPair, minute: EpochTimeStamp): Candle {
    const candle = createEmptyCandle(this.lastCandles.get(pair)!);
    candle.start = minute;
    return candle;
  }

  /** Refuses a total gap longer than MAX_GAP_FILL_MINUTES, which every pair would cross on flat candles */
  private checkTotalGap(gapStart: EpochTimeStamp, timestamp: EpochTimeStamp) {
    const gapMinutes = (timestamp - gapStart) / ONE_MINUTE;
    if (gapMinutes <= MAX_GAP_FILL_MINUTES) return;
    throw new GekkoError(
      'stream',
      [
        `No candle from ${toISOString(gapStart)} to ${toISOString(timestamp - ONE_MINUTE)} (${gapMinutes} minutes):`,
        `refusing to fill more than ${MAX_GAP_FILL_MINUTES} minutes with empty candles`,
      ].join(' '),
    );
  }

  /**
   * Refuses the bucket when it would fill a pair more than MAX_GAP_FILL_MINUTES minutes after its last candle, in the total gap
   * before the bucket or in the bucket itself. Only a total gap was bounded: a pair missing while another traded (suspended for
   * weeks) was filled minute after minute without end, and a total gap on the way was not counted in.
   */
  private checkFilledMinutes(bucket: CandleBucket, timestamp: EpochTimeStamp, totalGapStart?: EpochTimeStamp) {
    for (const pair of this.pairs) {
      // The last minute of the pair this bucket fills: the bucket's own, or the last of the total gap before it
      const fillsBucket = !bucket.has(pair) && this.isFilled(pair, timestamp);
      const fillsTotalGap = totalGapStart !== undefined && this.isFilled(pair, totalGapStart);
      const lastFilled = fillsBucket ? timestamp : fillsTotalGap ? timestamp - ONE_MINUTE : undefined;
      if (lastFilled === undefined) continue;

      const lastCandleStart = this.lastCandles.get(pair)!.start;
      const minutes = (lastFilled - lastCandleStart) / ONE_MINUTE;
      if (minutes <= MAX_GAP_FILL_MINUTES) continue;
      throw new GekkoError(
        'stream',
        [
          `No ${pair} candle from ${toISOString(lastCandleStart + ONE_MINUTE)} to ${toISOString(lastFilled)} (${minutes} minutes):`,
          `refusing to fill more than ${MAX_GAP_FILL_MINUTES} minutes with empty candles`,
        ].join(' '),
      );
    }
  }

  private fillTotalGap(gapStart: EpochTimeStamp, timestamp: EpochTimeStamp) {
    const gapMinutes = (timestamp - gapStart) / ONE_MINUTE;
    warning(
      'stream',
      `Total gap detected: filling ${gapMinutes} ${pluralize('minute', gapMinutes)} for all assets from ${toISOString(gapStart)}`,
    );

    // No bucket came between the last one and this one, so a pair has the same last candle and stream state all through the gap
    const filledPairs = this.pairs.filter(pair => this.isFilled(pair, gapStart));
    for (let minute = gapStart; minute < timestamp; minute += ONE_MINUTE) {
      if (filledPairs.length) this.push(new Map(filledPairs.map(pair => [pair, this.createFilledCandle(pair, minute)])));
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
   * since every pair has a last candle from then on. The candles it does hold still count as seen, so a pair seen in a dropped
   * bucket can be filled later on.
   *
   * Only the first drop is warned about, then the first pushed minute sums the drops up: a pair listed during a long warmup window
   * has no candle in thousands of its minutes, and a warning each would flood the log and evict the other warnings from the buffer
   * that Supervision forwards to Telegram.
   */
  private isIncompleteLeadingBucket(bucket: CandleBucket, timestamp: EpochTimeStamp) {
    const neverSeenPairs = this.pairs.filter(pair => !bucket.has(pair) && !this.lastCandles.has(pair));

    if (neverSeenPairs.length) {
      if (this.droppedLeadingMinutes === 0) {
        for (const pair of neverSeenPairs) {
          warning('stream', `No ${pair} candle at ${toISOString(timestamp)}: dropping the leading buckets until every pair has a candle`);
        }
      }
      for (const pair of this.pairs) {
        const candle = bucket.get(pair);
        if (candle) this.lastCandles.set(pair, candle);
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
