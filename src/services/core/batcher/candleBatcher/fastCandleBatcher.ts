import { ONE_MINUTE } from '@constants/time.const';
import { Candle } from '@models/candle.types';
import { warning } from '@services/logger';
import { getCandleTimeOffset } from '@utils/candle/candle.utils';
import { toISOString } from '@utils/date/date.utils';
import { CandleSize } from './candleBatcher.types';

/**
 * Tells whether the 1-minute candle starting at `start` is the last one of a timeframe candle of `candleSize` minutes: the next minute
 * starts a timeframe candle. Read on the calendar of getCandleTimeOffset, the one getCandleStart places the warmup and the backtest
 * candles on: a second copy of it here could be changed alone, and the batcher would then close its candles off their boundaries.
 */
export const isTimeframeCandleClose = (candleSize: CandleSize, start: EpochTimeStamp): boolean =>
  getCandleTimeOffset(candleSize, start + ONE_MINUTE) === 0;

/** Most decimals a volume is summed with: beyond, the scaled sum would exceed the integers a double holds exactly */
const MAX_VOLUME_DECIMALS = 15;
const MAX_VOLUME_FACTOR = 10 ** MAX_VOLUME_DECIMALS;

/**
 * Optimized candle batcher: aggregates the 1-minute candles of one pair in place, in a single object per timeframe candle.
 * For internal use by CandleBucketBatcher only.
 */
export class FastCandleBatcher {
  private accumulator: Candle | null = null;
  private readonly candleSize: CandleSize;
  /** Whether a candle starting on a timeframe boundary has been added yet: the ones before it are skipped */
  private hasStarted = false;
  private skippedMinutes = 0;
  private firstSkippedStart?: EpochTimeStamp;
  /**
   * The volume of the timeframe candle in progress, summed exactly (0.1 + 0.2 = 0.3) as an integer: each volume times
   * `volumeFactor`, the power of ten that leaves no decimal to any volume added so far.
   */
  private scaledVolume = 0;
  private volumeFactor = 1;

  constructor(candleSize: CandleSize) {
    this.candleSize = candleSize;
  }

  /**
   * Add a 1-minute candle. Returns the completed timeframe candle if ready: a new object, which the batcher no longer
   * touches once returned.
   */
  addCandle(candle: Candle): Candle | null {
    this.accumulate(candle);
    return isTimeframeCandleClose(this.candleSize, candle.start) ? this.flush() : null;
  }

  /** Returns the timeframe candle in progress, if any, and starts a new one. */
  flush(): Candle | null {
    const result = this.accumulator;
    if (result) result.volume = this.scaledVolume / this.volumeFactor;
    this.accumulator = null;
    this.scaledVolume = 0;
    this.volumeFactor = 1;
    return result;
  }

  /** Adds a 1-minute candle to the timeframe candle in progress, unless it comes before the first timeframe boundary. */
  accumulate(candle: Candle): void {
    if (!this.hasStarted && !this.startsOnBoundary(candle)) return;

    if (this.accumulator === null) {
      // First candle: shallow clone without `id`
      this.accumulator = {
        start: candle.start,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: 0, // Set by flush
      };
    } else {
      // Aggregate in-place
      this.accumulator.high = Math.max(this.accumulator.high, candle.high);
      this.accumulator.low = Math.min(this.accumulator.low, candle.low);
      this.accumulator.close = candle.close;
    }
    this.addVolume(candle.volume);
  }

  private addVolume(volume: number) {
    // Raise the factor until the volume has no decimal left once scaled. Volumes keep the precision of their pair, so this
    // loops only on the first candles of a timeframe candle, without the cost of counting decimals through toString.
    let factor = this.volumeFactor;
    while (Number.isFinite(volume) && Math.round(volume * factor) / factor !== volume && factor < MAX_VOLUME_FACTOR) factor *= 10;
    if (factor !== this.volumeFactor) {
      this.scaledVolume *= factor / this.volumeFactor;
      this.volumeFactor = factor;
    }
    this.scaledVolume += Math.round(volume * factor);
  }

  /**
   * Until a candle starts on a timeframe boundary, counts the candles before it, which would only make up a shorter and
   * misdated first timeframe candle, then warns once about them.
   */
  private startsOnBoundary(candle: Candle) {
    if (getCandleTimeOffset(this.candleSize, candle.start) !== 0) {
      this.firstSkippedStart ??= candle.start;
      this.skippedMinutes++;
      return false;
    }

    this.hasStarted = true;
    if (this.skippedMinutes > 0) {
      warning(
        'core',
        [
          `Skipped ${this.skippedMinutes} one-minute candle(s) from ${toISOString(this.firstSkippedStart)}:`,
          `the first ${this.candleSize}-minute candle starts on the first boundary, ${toISOString(candle.start)}`,
        ].join(' '),
      );
    }
    return true;
  }
}
