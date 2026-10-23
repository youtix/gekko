import { Indicator } from '../../indicator';
import { checkInteger } from '../../indicator.helper';
import { Candle } from '@gekko/shared/models/candle.types';
import { RingBuffer } from '@gekko/shared/helpers/collection/ringBuffer';

/** Rate of change: the percent change of the close over `period` candles. Its first value comes at candle period + 1, as in TA-Lib. */
export class ROC extends Indicator<'ROC'> {
  private ringBuffer: RingBuffer<number>;

  /** @param period - Candles between the close and its base: a whole number, at least 1. Required */
  constructor({ period }: IndicatorRegistry['ROC']['input']) {
    super();
    // A period of 0 gave a constant 0, the change of a close over no candle
    checkInteger('ROC', 'period', period);
    // The close `period` candles back and every close since. The buffer used to hold `period` closes, read before the push: the first
    // value was a change over period − 1 candles, and ROC(1) compared its first close with itself and returned 0.
    this.ringBuffer = new RingBuffer(period + 1);
  }

  public onNewCandle({ close }: Candle): void {
    this.update(close);
  }

  /** Takes the next close, or in its place a value of the indicator built on this one: TRIX gives its triple EMA */
  public update(close: number): void {
    this.ringBuffer.push(close);
    if (!this.ringBuffer.isFull()) return;

    const base = this.ringBuffer.first()!;
    // A change from 0 has no value: null rather than TA-Lib's 0, which reads as no change, or the ±Infinity of the division
    this.result = base === 0 ? null : (close / base - 1) * 100;
  }
}
