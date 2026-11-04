import { checkInputSource, checkInteger } from '../../indicator.helper';
import { MovingAverage } from '../movingAverage';

/**
 * The last period prices weighted 1 for the oldest to period for the last, over the sum of the weights, period × (period + 1) / 2.
 * Each candle used to sum the whole window again, O(period). The weighted and the plain sum now slide in O(1), and the window is still
 * summed afresh, as it used to be, once every period candles: sliding sums pile up rounding errors without end, some 1e-8 of the price
 * over a year of 1-minute candles, and with the fresh sums the result stays within some 1e-14 of the full sum's on prices.
 */
export class WMA extends MovingAverage<'WMA'> {
  private period: number;
  private divider: number;
  private prices: number[];
  /** Where the next price goes: the oldest price once the window is full */
  private index: number;
  private age: number;
  private weightedSum: number;
  private sum: number;
  private lastPrice: number;
  /** Candles in a row at the last price, that one included */
  private flatCandles: number;

  /**
   * @param period - Candles averaged, weighted 1 for the oldest to period for the last: a whole number, at least 1. Required
   * @param src - Price read from each candle: open, high, low, close, hl2, hlc3 or ohlc4. Default close
   */
  constructor({ period, src }: IndicatorRegistry['WMA']['input']) {
    checkInteger('WMA', 'period', period);
    checkInputSource('WMA', src);
    super(src);
    this.period = period;
    this.divider = (period * (period + 1)) / 2;
    this.prices = [];
    this.index = 0;
    this.age = 0;
    this.weightedSum = 0;
    this.sum = 0;
    // Equal to no price, so that the first one starts a run
    this.lastPrice = NaN;
    this.flatCandles = 0;
  }

  public update(price: number): void {
    this.flatCandles = price === this.lastPrice ? this.flatCandles + 1 : 1;
    this.lastPrice = price;
    // Warming up phase
    if (this.age < this.period) {
      this.prices[this.index] = price;
      this.index = (this.index + 1) % this.period;
      this.age++;
      if (this.age === this.period) this.result = this.sumWindow();
      return;
    }

    const oldest = this.prices[this.index];
    this.prices[this.index] = price;
    this.index = (this.index + 1) % this.period;
    // A window of one price, as an illiquid pair or gap-filled minutes make, keeps the average it was summed to when it turned flat, as
    // the full sum gave it on every candle: sliding the sums would move it by an ulp now and then, a slope on a market that did not move
    if (this.flatCandles > this.period) return;
    // Summed afresh every period candles, when the window turns flat, and while a sum is not finite: a NaN or an infinite price cannot
    // be taken back out of a sum, and would outlast its window
    if (this.index === 0 || this.flatCandles === this.period || !Number.isFinite(this.weightedSum) || !Number.isFinite(this.sum)) {
      this.result = this.sumWindow();
      return;
    }
    // Moving the window on takes one off every weight: the weighted sum loses the plain sum, and the new price comes in at weight period
    this.weightedSum += this.period * price - this.sum;
    this.sum += price - oldest;
    this.result = this.weightedSum / this.divider;
  }

  /** Sums the window afresh, oldest price first as the full sum always did, so that the average is the same to the bit */
  private sumWindow() {
    let weightedSum = 0;
    let sum = 0;
    for (let i = 0; i < this.period; i++) {
      const price = this.prices[(this.index + i) % this.period];
      weightedSum += price * (i + 1);
      sum += price;
    }
    this.weightedSum = weightedSum;
    this.sum = sum;
    return weightedSum / this.divider;
  }
}
