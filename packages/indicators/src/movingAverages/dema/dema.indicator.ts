import { checkInputSource, checkInteger } from '../../indicator.helper';
import { MovingAverage } from '../movingAverage';
import { isNil } from 'lodash-es';
import { EMA } from '../ema/ema.indicator';

export class DEMA extends MovingAverage<'DEMA'> {
  private inner: EMA;
  private outer: EMA;

  /**
   * @param period - Period of both EMAs: a whole number, at least 1. Required
   * @param src - Price read from each candle: open, high, low, close, hl2, hlc3 or ohlc4. Default close
   */
  constructor({ period, src }: IndicatorRegistry['DEMA']['input']) {
    checkInteger('DEMA', 'period', period);
    checkInputSource('DEMA', src);
    super(src);
    // Fed numbers through update, the price the DEMA reads and the first one's line, so that neither reads a candle nor takes src
    this.inner = new EMA({ period });
    this.outer = new EMA({ period });
  }

  public update(price: number) {
    this.inner.update(price);
    const innerRes = this.inner.getResult();
    if (!isNil(innerRes)) {
      this.outer.update(innerRes);
      const outerRes = this.outer.getResult();
      if (!isNil(outerRes)) this.result = 2 * innerRes - outerRes;
    }
  }
}
