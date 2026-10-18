import { checkBelow, checkInputSource, checkInteger } from '@indicators/indicator.helper';
import { EMA } from '@indicators/movingAverages/ema/ema.indicator';
import { Candle } from '@models/candle.types';
import { isNil } from 'lodash-es';
import { Indicator } from '../../indicator';

export class MACD extends Indicator<'MACD'> {
  private emaFast: EMA;
  private emaSlow: EMA;
  private emaSignal: EMA;
  private threshold: number;
  private age: number;

  /**
   * @param short - Period of the fast EMA: a whole number, at least 1, below long. Default 12
   * @param long - Period of the slow EMA: a whole number above short. Default 26
   * @param signal - Period of the signal line, the EMA of the MACD: a whole number, at least 1. Default 9
   * @param src - Price read from each candle: open, high, low, close, hl2, hlc3 or ohlc4. Default close
   */
  constructor({ short = 12, long = 26, signal = 9, src = 'close' }: IndicatorRegistry['MACD']['input'] = {}) {
    super();
    checkInteger('MACD', 'short', short);
    checkInteger('MACD', 'long', long);
    checkInteger('MACD', 'signal', signal);
    checkInputSource('MACD', src);
    // TA-Lib swaps them back. Refused instead: a strategy given them swapped by mistake would trade the opposite signal
    checkBelow('MACD', 'short', short, 'long', long, 'swapped periods give the opposite MACD, equal ones a MACD of 0');

    this.emaFast = new EMA({ period: short, src });
    this.emaSlow = new EMA({ period: long, src });
    this.emaSignal = new EMA({ period: signal });
    this.threshold = long - 1 - (short - 1);
    this.age = 0;
  }

  public onNewCandle(candle: Candle): void {
    this.emaSlow.onNewCandle(candle);

    if (this.age < this.threshold) {
      this.age++;
      return;
    }
    this.emaFast.onNewCandle(candle);

    const fast = this.emaFast.getResult();
    const slow = this.emaSlow.getResult();

    if (isNil(fast) || isNil(slow)) return;
    const macdLine = fast - slow;
    this.emaSignal.update(macdLine);
    const signalNum = this.emaSignal.getResult();

    if (isNil(signalNum)) return;
    const hist = macdLine - signalNum;

    this.result = {
      macd: macdLine,
      signal: signalNum,
      hist,
    };
  }
}
