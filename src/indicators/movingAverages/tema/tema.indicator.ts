import { checkInputSource, checkInteger } from '@indicators/indicator.helper';
import { MovingAverage } from '@indicators/movingAverages/movingAverage';
import { isNil } from 'lodash-es';
import { EMA } from '../ema/ema.indicator';

export class TEMA extends MovingAverage<'TEMA'> {
  private ema1: EMA;
  private ema2: EMA;
  private ema3: EMA;

  /**
   * @param period - Period of the three EMAs: a whole number, at least 1. Required
   * @param src - Price read from each candle: open, high, low, close, hl2, hlc3 or ohlc4. Default close
   */
  constructor({ period, src }: IndicatorRegistry['TEMA']['input']) {
    checkInteger('TEMA', 'period', period);
    checkInputSource('TEMA', src);
    super(src);
    // Fed numbers through update, the price the TEMA reads and the line of the EMA before, so that none reads a candle nor takes src
    this.ema1 = new EMA({ period });
    this.ema2 = new EMA({ period });
    this.ema3 = new EMA({ period });
  }

  public update(price: number) {
    // First EMA
    this.ema1.update(price);
    const e1 = this.ema1.getResult();
    if (isNil(e1)) return;

    // Second EMA
    this.ema2.update(e1);
    const e2 = this.ema2.getResult();
    if (isNil(e2)) return;

    // Third EMA
    this.ema3.update(e2);
    const e3 = this.ema3.getResult();
    if (isNil(e3)) return;

    this.result = 3 * e1 - 3 * e2 + e3;
  }
}
