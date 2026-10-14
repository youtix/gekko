import { Indicator } from '@indicators/indicator';
import { checkInteger, checkOneOf } from '@indicators/indicator.utils';
import { MOVING_AVERAGE_TYPES } from '@indicators/movingAverages/movingAverages.const';
import { RSI } from '@indicators/oscillators/rsi/rsi.indicator';
import { Candle } from '@models/candle.types';
import { isNil } from 'lodash-es';
import { Stochastic } from '../stochastic/stochastic.indicator';

/**
 * TA-Lib's STOCHRSI: the Stochastic of the RSI over period. fastK is the raw %K of the last fastKPeriod RSI values, 0 while the RSI
 * holds still, as over a flat stretch, and fastD its slowMaType average over fastDPeriod. The first result comes at candle
 * period + fastKPeriod + lookback(fastD), the lookback being fastDPeriod − 1, or 2 × (fastDPeriod − 1) for a dema: candle 21 by
 * default, 23 with a dema.
 */
export class StochasticRSI extends Indicator<'StochasticRSI'> {
  private rsi: RSI;
  private stoch: Stochastic;

  /**
   * @param period - Period of the RSI: a whole number, at least 2, TA-Lib's minimum, since an RSI of period 1 is 100 on a rise and 0 on
   * any other candle, and fastK only ever 0 or 100 with it. Default 14
   * @param fastKPeriod - RSI values in the range fastK places the RSI in: a whole number, at least 2. Default 5
   * @param fastDPeriod - Period of the average of fastK that makes fastD: a whole number, at least 1. Default 3
   * @param slowMaType - Kind of that average: sma, ema, dema or wma. Default sma
   */
  constructor({ period = 14, fastKPeriod = 5, fastDPeriod = 3, slowMaType = 'sma' }: IndicatorRegistry['StochasticRSI']['input'] = {}) {
    super();
    // Checked here, before the RSI checks it, so that the message names StochasticRSI
    checkInteger('StochasticRSI', 'period', period, 2, 'the RSI of a single change is only ever 0 or 100, and so is fastK');
    checkInteger('StochasticRSI', 'fastKPeriod', fastKPeriod, 2, 'the range of a single RSI value is 0, so fastK would always be 0');
    checkInteger('StochasticRSI', 'fastDPeriod', fastDPeriod);
    checkOneOf('StochasticRSI', 'slowMaType', slowMaType, MOVING_AVERAGE_TYPES);
    this.rsi = new RSI({ period });
    this.stoch = new Stochastic({
      fastKPeriod,
      slowKPeriod: 1,
      slowKMaType: slowMaType,
      slowDPeriod: fastDPeriod,
      slowDMaType: slowMaType,
    });
  }

  public onNewCandle(candle: Candle): void {
    this.rsi.onNewCandle(candle);
    const rsiValue = this.rsi.getResult();
    if (isNil(rsiValue)) return;

    this.stoch.update(rsiValue);
    const stoch = this.stoch.getResult();

    if (!isNil(stoch)) this.result = { fastK: stoch.k, fastD: stoch.d };
  }
}
