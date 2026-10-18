import { Indicator } from '@indicators/indicator';
import type { MovingAverageClasses } from '@indicators/indicator.types';
import { checkInteger, checkOneOf } from '@indicators/indicator.helper';
import { MOVING_AVERAGE_TYPES, MOVING_AVERAGES } from '@indicators/movingAverages/movingAverages.const';
import { Candle } from '@models/candle.types';
import { RingBuffer } from '@helpers/collection/ringBuffer';
import { compareWithTolerance } from '@utils/math/math.utils';
import { isNil } from 'lodash-es';

/**
 * TA-Lib's STOCH. The raw %K places the close in the range of the last fastKPeriod candles: 0 at the lowest low, 100 at the highest
 * high, 0 when the range is flat, its ends equal within the tolerance of compareWithTolerance. k is its slowKMaType average over
 * slowKPeriod, and d the slowDMaType average of k over slowDPeriod.
 * The first result comes at candle fastKPeriod + lookback(k) + lookback(d), where an average's lookback is period − 1, or
 * 2 × (period − 1) for a dema: candle 9 by default, 13 when both averages are 3-candle demas. A dema overshoots its input, so a k or
 * a d smoothed by one can leave [0, 100], as in TA-Lib.
 */
export class Stochastic extends Indicator<'Stochastic'> {
  private highs: RingBuffer<number>;
  private lows: RingBuffer<number>;
  private maSlowK: MovingAverageClasses;
  private maSlowD: MovingAverageClasses;

  /**
   * @param fastKPeriod - Candles of the range the raw %K places the close in: a whole number, at least 1. Default 5
   * @param slowKPeriod - Period of the average of the raw %K that makes k: a whole number, at least 1. Default 3
   * @param slowKMaType - Kind of that average: sma, ema, dema or wma. Default sma
   * @param slowDPeriod - Period of the average of k that makes d: a whole number, at least 1. Default 3
   * @param slowDMaType - Kind of that average: sma, ema, dema or wma. Default sma
   */
  constructor({
    fastKPeriod = 5,
    slowKPeriod = 3,
    slowKMaType = 'sma',
    slowDPeriod = 3,
    slowDMaType = 'sma',
  }: IndicatorRegistry['Stochastic']['input'] = {}) {
    super();
    checkInteger('Stochastic', 'fastKPeriod', fastKPeriod);
    checkInteger('Stochastic', 'slowKPeriod', slowKPeriod);
    checkOneOf('Stochastic', 'slowKMaType', slowKMaType, MOVING_AVERAGE_TYPES);
    checkInteger('Stochastic', 'slowDPeriod', slowDPeriod);
    checkOneOf('Stochastic', 'slowDMaType', slowDMaType, MOVING_AVERAGE_TYPES);
    this.highs = new RingBuffer(fastKPeriod);
    this.lows = new RingBuffer(fastKPeriod);
    this.maSlowK = new MOVING_AVERAGES[slowKMaType]({ period: slowKPeriod });
    this.maSlowD = new MOVING_AVERAGES[slowDMaType]({ period: slowDPeriod });
  }

  public onNewCandle({ high, low, close }: Candle) {
    this.next(high, low, close);
  }

  /** Takes the next value of a series that has no range within a candle, as its own high, low and close: StochasticRSI gives its RSI */
  public update(value: number) {
    this.next(value, value, value);
  }

  /** The high, low and close of the next candle, or a value as all three */
  private next(high: number, low: number, close: number) {
    this.highs.push(high);
    this.lows.push(low);
    // The raw %K used to be taken over the partial windows of the first candles, and d fed 0 while k was not ready: an ema or a dema
    // seeded on those values carried their error for many candles, and a warm-up count that assumed period − 1 lookbacks published
    // a dema-smoothed result too early. Each average now only gets real values, and the result waits for d.
    if (!this.highs.isFull()) return;

    // Read in place: they used to be spread into Math.min and Math.max
    const lowest = this.lows.min();
    const highest = this.highs.max();
    const range = highest - lowest;
    // StochasticRSI feeds RSI values, which hold still over a flat stretch in exact arithmetic but wobble in their last bits: the range
    // used to be that wobble, and the raw %K 0 or 100 at random. Ends equal within the tolerance make a flat range.
    const rawK = compareWithTolerance(highest, lowest) === 0 ? 0 : ((close - lowest) / range) * 100;

    this.maSlowK.update(rawK);
    const slowK = this.maSlowK.getResult();
    if (isNil(slowK)) return;

    this.maSlowD.update(slowK);
    const slowD = this.maSlowD.getResult();
    if (!isNil(slowD)) this.result = { k: slowK, d: slowD };
  }
}
