import { DirectionalMovement } from '../directionalMovement';
import { Indicator } from '../../indicator';
import { checkInteger } from '../../indicator.helper';
import { Candle } from '@gekko/shared/models/candle.types';

export class MinusDM extends Indicator<'MinusDM'> {
  private readonly movement: DirectionalMovement;

  /**
   * @param period - Candles of the first sum, and the divisor of the smoothing: a whole number, at least 1, where 1 gives each
   * candle's own −DM. Required
   */
  constructor({ period }: IndicatorRegistry['MinusDM']['input']) {
    super();
    checkInteger('MinusDM', 'period', period);
    this.movement = new DirectionalMovement(period);
  }

  public onNewCandle(candle: Candle): void {
    this.movement.onNewCandle(candle);
    this.result = this.movement.getDM('minus');
  }
}
