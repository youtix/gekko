import { Indicator } from '../../indicator';
import { checkInteger } from '../../indicator.helper';
import { Candle } from '@gekko/shared/models/candle.types';
import { RingBuffer } from '@gekko/shared/helpers/collection/ringBuffer';

export class WilliamsR extends Indicator<'WilliamsR'> {
  private ringBufferHigh: RingBuffer<number>;
  private ringBufferLow: RingBuffer<number>;

  /** @param period - Candles of the range the close is placed in: a whole number, at least 1. Default 14 */
  constructor({ period = 14 }: IndicatorRegistry['WilliamsR']['input'] = {}) {
    super();
    checkInteger('WilliamsR', 'period', period);
    this.ringBufferHigh = new RingBuffer(period);
    this.ringBufferLow = new RingBuffer(period);
  }

  public onNewCandle({ high, low, close }: Candle): void {
    this.ringBufferHigh.push(high);
    this.ringBufferLow.push(low);

    // Warmup phase
    if (!this.ringBufferHigh.isFull()) return;

    const highest = this.ringBufferHigh.max();
    const lowest = this.ringBufferLow.min();
    // Williams %R = (Close - HighestHigh) / (HighestHigh - LowestLow) * 100. The close used to go through a third buffer of its own,
    // only to be read back as its last item
    this.result = highest === lowest ? 0 : ((close - highest) / (highest - lowest)) * 100;
  }
}
