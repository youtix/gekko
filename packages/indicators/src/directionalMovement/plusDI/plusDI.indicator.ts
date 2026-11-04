import { DirectionalMovement } from '../directionalMovement';
import { Indicator } from '../../indicator';
import { checkInteger } from '../../indicator.helper';
import { Candle } from '@gekko/shared/models/candle.types';

export class PlusDI extends Indicator<'PlusDI'> {
  private readonly movement: DirectionalMovement;

  /** @param period - Period of the smoothed +DM and true range: a whole number, at least 1. Required */
  constructor({ period }: IndicatorRegistry['PlusDI']['input']) {
    super();
    checkInteger('PlusDI', 'period', period);
    this.movement = new DirectionalMovement(period);
  }

  public onNewCandle(candle: Candle): void {
    this.movement.onNewCandle(candle);
    this.result = this.movement.getDI('plus');
  }
}
