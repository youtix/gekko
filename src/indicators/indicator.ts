import { Candle } from '@models/candle.types';
import type { IndicatorNames } from './indicator.types';

/**
 * The result is null until the indicator has seen enough candles, then always a complete value of its output type: a number, or an
 * object whose declared fields are all set. Never a partial object or a placeholder number. Indicators used to start some objects
 * with null fields, fill them in one by one, or start at 0, so a strategy that only checked for null read a warming-up value.
 * The one exception after warm-up is ROC, and TRIX built on it: null on a candle whose base is 0, since a change from 0 has no value.
 * A constructor refuses a parameter the indicator cannot compute with, through the checks of indicator.helper.ts: a GekkoError names the
 * indicator, the parameter and what it accepts.
 * An indicator built on another feeds it numbers through its update method, which every moving average has (MovingAverage), never a
 * made-up candle cast to Candle: the cast hid from tsc which fields the inner indicator read.
 */
export abstract class Indicator<T extends IndicatorNames = IndicatorNames> {
  protected result: IndicatorRegistry[T]['output'] | null = null;

  public abstract onNewCandle(candle: Candle): void;

  public getResult(): IndicatorRegistry[T]['output'] | null {
    return this.result;
  }
}
