import { DirectionalMovement } from '@indicators/directionalMovement/directionalMovement';
import { Indicator } from '@indicators/indicator';
import { checkInteger } from '@indicators/indicator.helper';
import { Candle } from '@models/candle.types';
import { isNil } from 'lodash-es';

export class DX extends Indicator<'DX'> {
  // One for both DIs: DX used to build a PlusDI and a MinusDI, so it computed the true range of every candle twice
  private readonly movement: DirectionalMovement;

  /** @param period - Period of the two directional indicators: a whole number, at least 2. Required */
  constructor({ period }: IndicatorRegistry['DX']['input']) {
    super();
    // With period 1 one of the two DIs is always 0, so DX was 100 on a candle with directional movement and 0 on any other, an inside
    // candle included. TA-Lib's minimum is 2 as well
    checkInteger('DX', 'period', period, 2, 'the DX of a single candle is 100, or 0/0 when it has no directional movement');
    this.movement = new DirectionalMovement(period);
  }

  public onNewCandle(candle: Candle): void {
    this.movement.onNewCandle(candle);
    const minusDI = this.movement.getDI('minus');
    const plusDI = this.movement.getDI('plus');
    if (isNil(minusDI) || isNil(plusDI)) return;

    // DX = 100 * (abs(minusDI - plusDI) / (minusDI + plusDI))
    const sumDI = minusDI + plusDI;
    this.result = sumDI === 0 ? 0 : (100 * Math.abs(minusDI - plusDI)) / sumDI;
  }
}
