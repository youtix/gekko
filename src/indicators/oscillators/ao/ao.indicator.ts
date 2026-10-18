import { Indicator } from '@indicators/indicator';
import { checkBelow, checkInteger } from '@indicators/indicator.helper';
import { SMA } from '@indicators/movingAverages/sma/sma.indicator';
import { Candle } from '@models/candle.types';
import { isNil } from 'lodash-es';

export class AO extends Indicator<'AO'> {
  private smaFast: SMA;
  private smaSlow: SMA;

  /**
   * @param short - Period of the fast SMA of the midpoints: a whole number, at least 1, below long. Default 5
   * @param long - Period of the slow SMA: a whole number above short. Default 34
   */
  constructor({ short = 5, long = 34 }: IndicatorRegistry['AO']['input'] = {}) {
    super();
    checkInteger('AO', 'short', short);
    checkInteger('AO', 'long', long);
    checkBelow('AO', 'short', short, 'long', long, 'swapped periods give the opposite AO, equal ones an AO of 0');
    this.smaFast = new SMA({ period: short });
    this.smaSlow = new SMA({ period: long });
  }

  public onNewCandle({ high, low }: Candle): void {
    // Typical price: midpoint of the bar
    const hl2 = (high + low) / 2;

    // Update fast and slow SMAs
    this.smaFast.update(hl2);
    this.smaSlow.update(hl2);

    const fastValue = this.smaFast.getResult();
    const slowValue = this.smaSlow.getResult();

    if (isNil(fastValue) || isNil(slowValue)) return;
    this.result = fastValue - slowValue;
  }
}
