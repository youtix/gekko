import { checkBelow, checkInteger } from '@indicators/indicator.helper';
import { EMA } from '@indicators/movingAverages/ema/ema.indicator';
import { Candle } from '@models/candle.types';
import { isNil } from 'lodash-es';
import { Indicator } from '../../indicator';
import { ATR } from '../atr/atr.indicator';

/**
 * MACD's line, signal and histogram on volatility: the line is a fast ATR minus a slow one, where MACD subtracts two EMAs of the price.
 * The class began as a copy of MACD, and its ATRs kept the names of MACD's EMAs.
 */
export class ATRCD extends Indicator<'ATRCD'> {
  private atrFast: ATR;
  private atrSlow: ATR;
  private emaSignal: EMA;
  private threshold: number;
  private age: number;

  /**
   * @param short - Period of the fast ATR: a whole number, at least 1, below long. Default 12
   * @param long - Period of the slow ATR: a whole number above short. Default 26
   * @param signal - Period of the signal line, the EMA of the ATRCD: a whole number, at least 1. Default 9
   */
  constructor({ short = 12, long = 26, signal = 9 }: IndicatorRegistry['ATRCD']['input'] = {}) {
    super();
    checkInteger('ATRCD', 'short', short);
    checkInteger('ATRCD', 'long', long);
    checkInteger('ATRCD', 'signal', signal);
    checkBelow('ATRCD', 'short', short, 'long', long, 'swapped periods give the opposite ATRCD, equal ones an ATRCD of 0');

    this.atrFast = new ATR({ period: short });
    this.atrSlow = new ATR({ period: long });
    this.emaSignal = new EMA({ period: signal });
    // The fast ATR starts long − short candles later, so that both are ready on the same candle, as MACD's EMAs are
    this.threshold = long - 1 - (short - 1);
    this.age = 0;
  }

  public onNewCandle(candle: Candle): void {
    this.atrSlow.onNewCandle(candle);

    if (this.age < this.threshold) {
      this.age++;
      return;
    }
    this.atrFast.onNewCandle(candle);

    const fast = this.atrFast.getResult();
    const slow = this.atrSlow.getResult();

    if (isNil(fast) || isNil(slow)) return;
    const atrcdLine = fast - slow;
    this.emaSignal.update(atrcdLine);
    const signalNum = this.emaSignal.getResult();

    if (isNil(signalNum)) return;
    const hist = atrcdLine - signalNum;

    this.result = {
      atrcd: atrcdLine,
      signal: signalNum,
      hist,
    };
  }
}
