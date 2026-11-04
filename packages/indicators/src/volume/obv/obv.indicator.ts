import { checkInteger, checkNumber, checkOneOf } from '../../indicator.helper';
import { MOVING_AVERAGE_TYPES } from '../../movingAverages/movingAverages.const';
import { BollingerBands } from '../../volatility/bollingerBands/bollingerBands.indicator';
import { Candle } from '@gekko/shared/models/candle.types';
import { isNil } from 'lodash-es';
import { Indicator } from '../../indicator';

/**
 * TA-Lib's OBV, with Bollinger bands around it: the volume of the first candle, then each candle's volume added when its close rose
 * and subtracted when it fell. The result comes with the bands, from candle period on (2 × period − 1 with a dema).
 */
export class OBV extends Indicator<'OBV'> {
  private prevClose?: number;
  private obv: number;
  private bb: BollingerBands;

  /**
   * @param period - Candles of the bands' middle and deviation: a whole number, at least 2. Default 14
   * @param stdevUp - Deviations from the middle to the upper band: a number, at least 0. Default 2
   * @param stdevDown - Deviations from the middle to the lower band: a number, at least 0. Default 2
   * @param maType - Kind of moving average of the middle band: sma, ema, dema or wma. Default sma
   */
  constructor({ period = 14, stdevUp = 2, stdevDown = 2, maType = 'sma' }: IndicatorRegistry['OBV']['input'] = {}) {
    super();
    // Checked here, before the bands check them, so that the message names OBV
    checkInteger('OBV', 'period', period, 2, 'the bands of a single candle are the OBV itself: its deviation is 0');
    checkNumber('OBV', 'stdevUp', stdevUp, { atLeast: 0 });
    checkNumber('OBV', 'stdevDown', stdevDown, { atLeast: 0 });
    checkOneOf('OBV', 'maType', maType, MOVING_AVERAGE_TYPES);
    this.obv = 0;
    this.bb = new BollingerBands({ period, stdevDown, stdevUp, maType });
  }

  public onNewCandle(candle: Candle): void {
    // The first candle, which has no close to compare with, used to be skipped: the OBV started a candle later than TA-Lib's, at 0
    // rather than at that candle's volume, so its level was off by that volume and its bands came a candle late
    if (isNil(this.prevClose)) this.obv = candle.volume;
    else if (candle.close > this.prevClose) this.obv += candle.volume;
    else if (candle.close < this.prevClose) this.obv -= candle.volume;
    this.prevClose = candle.close;

    this.bb.update(this.obv);
    const bands = this.bb.getResult();
    // The OBV alone went out while its bands warmed up
    if (isNil(bands)) return;

    this.result = {
      obv: this.obv,
      ma: bands.middle,
      upper: bands.upper,
      lower: bands.lower,
    };
  }
}
