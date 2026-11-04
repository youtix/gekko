import { Indicator } from '../indicator';
import type { IndicatorNames } from '../indicator.types';
import { getInputSource } from '../indicator.helper';
import { Candle } from '@gekko/shared/models/candle.types';
import { InputSources } from '@gekko/shared/models/inputSources.types';

/**
 * A moving average of one number per candle, the price its src names. It takes each number through update, which onNewCandle calls
 * with the candle's price, so that an indicator built on one feeds it its own values as they are: a force, a true range, the line of
 * another average. Those used to go in as the close of a made-up candle cast to Candle, an object per value and a cast that hid from
 * tsc which fields the average read: one built with another src read a field that candle lacked, and was NaN.
 * A new moving average extends this class: it checks its parameters, passes src to super and implements update.
 */
export abstract class MovingAverage<T extends IndicatorNames = IndicatorNames> extends Indicator<T> {
  private readonly getPrice: (candle: Candle) => number;

  /** @param src - Price read from each candle, checked by the subclass before it calls super, so that a refusal names it. Default close */
  constructor(src?: InputSources) {
    super();
    this.getPrice = getInputSource(src);
  }

  public onNewCandle(candle: Candle): void {
    this.update(this.getPrice(candle));
  }

  /** Takes the next number of the series: the price of a candle, or a value of the indicator built on this one */
  public abstract update(value: number): void;
}
