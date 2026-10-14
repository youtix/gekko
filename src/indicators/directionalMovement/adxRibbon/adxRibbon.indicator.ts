import { checkInteger } from '@indicators/indicator.utils';
import { Candle } from '@models/candle.types';
import { isFiniteNumber } from '@utils/math/math.utils';
import { Indicator } from '../../indicator';
import { ADX } from '../adx/adx.indicator';

export class ADXRibbon extends Indicator<'ADXRibbon'> {
  private adxs: ADX[] = [];

  /**
   * @param count - ADXs in the ribbon: a whole number, at least 1. Default 19
   * @param start - Period of the first ADX: a whole number, at least 2. Default 12
   * @param step - Period added from one ADX to the next: a whole number, at least 1. Default 3
   */
  constructor({ count = 19, start = 12, step = 3 }: IndicatorRegistry['ADXRibbon']['input'] = {}) {
    super();
    // A count of 0 made a ribbon without ADXs, never null, whose spread was -Infinity
    checkInteger('ADXRibbon', 'count', count);
    // A start of 1 made the first ADX one of a single candle, which jumped between 100 and 0 (see DX), so it set the spread on its own
    checkInteger('ADXRibbon', 'start', start, 2, 'the ADX of a single candle is 100, or 0/0 when it has no directional movement');
    checkInteger('ADXRibbon', 'step', step);
    for (let i = 0; i < count; i++) this.adxs.push(new ADX({ period: start + i * step }));
  }

  public onNewCandle(candle: Candle): void {
    // One pass over the ADXs, which every candle used to go through with a closure, then scan again for numbers and spread twice
    const results: number[] = [];
    let highest = -Infinity;
    let lowest = Infinity;
    for (const adx of this.adxs) {
      adx.onNewCandle(candle);
      const result = adx.getResult();
      // Not ready, or not a finite number: lodash's isNumber let a NaN ADX through, and the spread with it
      if (!isFiniteNumber(result)) continue;
      results.push(result);
      highest = Math.max(highest, result);
      lowest = Math.min(lowest, result);
    }
    // Ready once every ADX is
    if (results.length < this.adxs.length) return;

    this.result = { results, spread: highest - lowest };
  }
}
