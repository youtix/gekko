import { RingBuffer } from '@helpers/collection/ringBuffer';
import { Indicator } from '@indicators/indicator';
import { checkInteger, checkNumber, checkOneOf } from '@indicators/indicator.helper';
import type { MovingAverageClasses } from '@indicators/indicator.types';
import { MOVING_AVERAGE_TYPES, MOVING_AVERAGES } from '@indicators/movingAverages/movingAverages.const';
import { Candle } from '@models/candle.types';
import { compareWithTolerance } from '@utils/math/math.utils';
import { isNil } from 'lodash-es';
import { addSquare } from './bollingerBands.helper';

/**
 * TA-Lib's BBANDS: a middle band, the maType average of the close over period, and an upper and a lower band stdevUp and stdevDown
 * population standard deviations of those closes away from it, from the candle the middle is ready on: period, 2 × period − 1 with
 * a dema. On a flat window, its closes equal within the tolerance of compareWithTolerance, the deviation is 0: the three bands are
 * the middle, and the close itself once the middle sits on it within the tolerance. A middle still lagging a move, as an ema's or a
 * dema's does after one, stays where it is.
 */
export class BollingerBands extends Indicator<'BollingerBands'> {
  private stdevUp: number;
  private stdevDown: number;
  private ma: MovingAverageClasses;
  private ringBuffer: RingBuffer<number>;

  /**
   * @param period - Candles of the middle band and of the deviation: a whole number, at least 2. Default 5
   * @param stdevUp - Deviations from the middle to the upper band: a number, at least 0. Default 2
   * @param stdevDown - Deviations from the middle to the lower band: a number, at least 0. Default 2
   * @param maType - Kind of moving average of the middle band: sma, ema, dema or wma. Default sma
   */
  constructor({ period = 5, stdevUp = 2, stdevDown = 2, maType = 'sma' }: IndicatorRegistry['BollingerBands']['input'] = {}) {
    super();
    checkInteger('BollingerBands', 'period', period, 2, 'the bands of a single candle are its close: its deviation is 0');
    // A negative multiplier put the band on the other side of the middle: upper below it, or lower above it
    checkNumber('BollingerBands', 'stdevUp', stdevUp, { atLeast: 0 });
    checkNumber('BollingerBands', 'stdevDown', stdevDown, { atLeast: 0 });
    checkOneOf('BollingerBands', 'maType', maType, MOVING_AVERAGE_TYPES);
    this.stdevUp = stdevUp;
    this.stdevDown = stdevDown;
    this.ma = new MOVING_AVERAGES[maType]({ period });
    this.ringBuffer = new RingBuffer(period);
  }

  public onNewCandle({ close }: Candle): void {
    this.update(close);
  }

  /** Takes the next close, or in its place a value of the indicator built on this one: OBV gives its OBV */
  public update(close: number): void {
    //  Warmup phase
    this.ma.update(close);
    this.ringBuffer.push(close);
    if (!this.ringBuffer.isFull()) return;

    const middle = this.ma.getResult();
    // A middle of exactly 0, as an OBV's can be, used to read as not ready: the bands stayed null or kept the previous candle's
    if (isNil(middle)) return;

    // A flat window used to get a deviation of a few ulps rather than 0, around a middle itself a few ulps off the close, so the close
    // lay outside bands a few ulps wide in most flat windows: a breakout on a market that did not move. A middle within the tolerance
    // of the close is the close; one further off, an ema or a dema still catching up with a move, is a real distance and is kept
    if (compareWithTolerance(this.ringBuffer.max(), this.ringBuffer.min()) === 0) {
      const band = compareWithTolerance(middle, close) === 0 ? close : middle;
      this.result = { upper: band, middle: band, lower: band };
      return;
    }

    // stdev()'s population deviation around the simple mean, with its operations in its order, on the window in place: stdev() took a
    // copy of the window, and a mapped copy of that, on every candle. Its sum of squares starts from the first square and this one from
    // 0, which is the same: a square is never -0
    const mean = this.ringBuffer.sum() / this.ringBuffer.length;
    const squares = this.ringBuffer.reduce(addSquare, 0, mean);
    const standardDeviation = Math.sqrt(squares / this.ringBuffer.length);

    // Upper and Lower Bands
    const upper = middle + this.stdevUp * standardDeviation;
    const lower = middle - this.stdevDown * standardDeviation;

    this.result = { upper, middle, lower };
  }
}
