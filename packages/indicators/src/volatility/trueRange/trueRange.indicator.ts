import { Indicator } from '../../indicator';
import { Candle } from '@gekko/shared/models/candle.types';
import { getTrueRange } from './trueRange.helper';

export class TrueRange extends Indicator<'TrueRange'> {
  private prevCandle?: Candle;

  public onNewCandle(candle: Candle): void {
    // The first candle has no previous close to measure a gap from
    if (this.prevCandle) this.result = getTrueRange(this.prevCandle, candle);
    this.prevCandle = candle;
  }
}
