import { Indicator } from '../../indicator';
import { checkInteger } from '../../indicator.helper';
import { EMA } from '../../movingAverages/ema/ema.indicator';
import { Candle } from '@gekko/shared/models/candle.types';
import { isNil } from 'lodash-es';
import { ROC } from '../roc/roc.indicator';

/** The one-candle rate of change of a triple EMA, in percent. Its first value comes at candle 3 × (period − 1) + 2, as in TA-Lib. */
export class TRIX extends Indicator<'TRIX'> {
  private ema1: EMA;
  private ema2: EMA;
  private ema3: EMA;
  private roc: ROC;

  /** @param period - Period of the three EMAs: a whole number, at least 1. Default 30 */
  constructor({ period = 30 }: IndicatorRegistry['TRIX']['input'] = {}) {
    super();
    checkInteger('TRIX', 'period', period);
    this.ema1 = new EMA({ period });
    this.ema2 = new EMA({ period });
    this.ema3 = new EMA({ period });
    this.roc = new ROC({ period: 1 });
  }

  public onNewCandle(candle: Candle): void {
    this.ema1.onNewCandle(candle);
    const ema1Result = this.ema1.getResult();
    if (isNil(ema1Result)) return;

    this.ema2.update(ema1Result);
    const ema2Result = this.ema2.getResult();
    if (isNil(ema2Result)) return;

    this.ema3.update(ema2Result);
    const ema3Result = this.ema3.getResult();
    if (isNil(ema3Result)) return;

    this.roc.update(ema3Result);
    this.result = this.roc.getResult();
  }
}
