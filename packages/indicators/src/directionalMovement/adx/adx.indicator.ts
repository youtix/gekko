import { Indicator } from '../../indicator';
import { checkInteger } from '../../indicator.helper';
import { WilderSmoothing } from '../../movingAverages/wilderSmoothing/wilderSmoothing.indicator';
import { Candle } from '@gekko/shared/models/candle.types';
import { isNil } from 'lodash-es';
import { DX } from '../dx/dx.indicator';

export class ADX extends Indicator<'ADX'> {
  private dx: DX;
  private smoothing: WilderSmoothing;

  /** @param period - Period of the DX and of its smoothing: a whole number, at least 2. Required */
  constructor({ period }: IndicatorRegistry['ADX']['input']) {
    super();
    // ADX(1) is DX(1), which jumped between 100 and 0 (see DX)
    checkInteger('ADX', 'period', period, 2, 'the ADX of a single candle is 100, or 0/0 when it has no directional movement');
    this.dx = new DX({ period });
    this.smoothing = new WilderSmoothing({ period });
  }

  public onNewCandle(candle: Candle): void {
    this.dx.onNewCandle(candle);
    const dx = this.dx.getResult();
    if (isNil(dx)) return;

    // ADX is Wilder's smoothing of DX: it used to repeat the recurrence inline instead of sharing the class ATR and RSI use
    this.smoothing.update(dx);
    this.result = this.smoothing.getResult();
  }
}
