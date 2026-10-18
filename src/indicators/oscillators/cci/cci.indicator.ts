import { hlc3 } from '@helpers/candle/candle.helper';
import { RingBuffer } from '@helpers/collection/ringBuffer';
import { Indicator } from '@indicators/indicator';
import { checkInteger } from '@indicators/indicator.helper';
import { Candle } from '@models/candle.types';
import { compareWithTolerance } from '@utils/math/math.utils';
import { addDeviation } from './cci.helper';

/**
 * TA-Lib's CCI: how far the typical price is from its mean over period, in units of 0.015 × their mean deviation, from candle period
 * on. A flat window gives 0, flat meaning that its typical prices are equal within the tolerance of compareWithTolerance.
 */
export class CCI extends Indicator<'CCI'> {
  private typicalPrices: RingBuffer<number>;
  private period: number;

  /** @param period - Candles of the mean and of the mean deviation of the typical price: a whole number, at least 2. Default 14 */
  constructor({ period = 14 }: IndicatorRegistry['CCI']['input'] = {}) {
    super();
    checkInteger('CCI', 'period', period, 2, 'the CCI of a single candle is always 0');
    this.typicalPrices = new RingBuffer(period);
    this.period = period;
  }

  public onNewCandle(candle: Candle): void {
    // Each candle's typical price, taken once. The window used to hold the candles: every candle copied it and mapped it to typical
    // prices again, four arrays per candle, and spread them into Math.max and Math.min
    const typicalPrice = hlc3(candle);
    this.typicalPrices.push(typicalPrice);
    // Warmup phase
    if (!this.typicalPrices.isFull()) return;

    // A flat window used to give ±66.67 with a random sign instead of 0: its mean, summed in floating point, lands a few ulps off the
    // price, and the mean deviation was that residue. Flatness is now read on the typical prices, within the tolerance: a candle that
    // traded a tick either side of a flat price and closed on it has that typical price in exact arithmetic, not always in floating point
    if (compareWithTolerance(this.typicalPrices.max(), this.typicalPrices.min()) === 0) {
      this.result = 0;
      return;
    }

    const mean = this.typicalPrices.sum() / this.period;
    const devSum = this.typicalPrices.reduce(addDeviation, 0, mean);
    const denom = (devSum / this.period) * 0.015;
    this.result = (typicalPrice - mean) / denom;
  }
}
