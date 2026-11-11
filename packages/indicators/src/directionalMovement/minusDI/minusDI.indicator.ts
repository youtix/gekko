import { DirectionalMovement } from '../directionalMovement';
import { Indicator } from '../../indicator';
import { checkInteger } from '../../indicator.helper';
import { Candle } from '@gekko/shared/models/candle.types';

export class MinusDI extends Indicator<'MinusDI'> {
  private readonly movement: DirectionalMovement;

  /** @param period - Period of the smoothed −DM and true range: a whole number, at least 1. Required */
  constructor({ period }: IndicatorRegistry['MinusDI']['input']) {
    super();
    checkInteger('MinusDI', 'period', period);
    this.movement = new DirectionalMovement(period);
  }

  public onNewCandle(candle: Candle): void {
    this.movement.onNewCandle(candle);
    this.result = this.movement.getDI('minus');
  }
}
