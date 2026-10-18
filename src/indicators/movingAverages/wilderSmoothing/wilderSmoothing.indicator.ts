import { checkInputSource, checkInteger } from '@indicators/indicator.helper';
import { MovingAverage } from '@indicators/movingAverages/movingAverage';

/**
 * Wilder's smoothing: the mean of the first period values, then ((period − 1) × previous + value) / period. SMMA is this class
 * under another name, and ATR, RSI and ADX smooth with it, so a change here changes them and the indicators built on them.
 */
export class WilderSmoothing extends MovingAverage<'WilderSmoothing'> {
  private period: number;
  private age: number;
  private sum: number;
  private prevSmoothed: number;

  /**
   * @param period - Candles of the first mean, and the divisor of the smoothing: a whole number, at least 1. Default 14
   * @param src - Price read from each candle: open, high, low, close, hl2, hlc3 or ohlc4. Default close
   */
  constructor({ period = 14, src }: IndicatorRegistry['WilderSmoothing']['input'] = {}) {
    checkInteger('WilderSmoothing', 'period', period);
    checkInputSource('WilderSmoothing', src);
    super(src);
    this.period = period;
    this.age = 0;
    this.sum = 0;
    this.prevSmoothed = 0;
  }

  public update(price: number): void {
    // Warmup: accumulate first 'period' values for simple average
    if (this.age < this.period) {
      this.sum += price;
      this.age++;

      // Once enough data, initialize smoothed value
      if (this.age === this.period) {
        this.prevSmoothed = this.sum / this.period;
        this.result = this.prevSmoothed;
      }
      return;
    }

    // Wilder's smoothing: (prev*(period-1) + price) / period
    this.prevSmoothed = (this.prevSmoothed * (this.period - 1) + price) / this.period;
    this.result = this.prevSmoothed;
  }
}
