import { Indicator } from '@indicators/indicator';
import { checkInteger } from '@indicators/indicator.helper';
import { Candle } from '@models/candle.types';
import { isNil } from 'lodash-es';
import { WilderSmoothing } from '../../movingAverages/wilderSmoothing/wilderSmoothing.indicator';
import { TrueRange } from '../trueRange/trueRange.indicator';

export class ATR extends Indicator<'ATR'> {
  private period: number;
  private truerange: TrueRange;
  private smoothing: WilderSmoothing;

  /** @param period - Period of the smoothed true range: a whole number, at least 1. Required */
  constructor({ period }: IndicatorRegistry['ATR']['input']) {
    super();
    checkInteger('ATR', 'period', period);
    this.period = period;
    this.truerange = new TrueRange();
    this.smoothing = new WilderSmoothing({ period: this.period });
  }

  public onNewCandle(candle: Candle): void {
    this.truerange.onNewCandle(candle);
    const tr = this.truerange.getResult();
    if (isNil(tr)) return;

    this.smoothing.update(tr);
    this.result = this.smoothing.getResult();
  }
}
