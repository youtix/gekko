import type { MovingAverageClasses } from '../../indicator.types';
import { checkInputSource, checkInteger, checkOneOf, getInputSource } from '../../indicator.helper';
import { MOVING_AVERAGE_TYPES, MOVING_AVERAGES } from '../../movingAverages/movingAverages.const';
import { Candle } from '@gekko/shared/models/candle.types';
import { isNil } from 'lodash-es';
import { Indicator } from '../../indicator';

/** Elder's force index: the change of the src price times the volume (fi), and its maType moving average over period (smoothed) */
export class EFI extends Indicator<'EFI'> {
  private ma: MovingAverageClasses;
  private prevPrice?: number;
  private getPrice: (candle: Candle) => number;

  /**
   * @param period - Period of the moving average of the force: a whole number, at least 1. Default 13
   * @param maType - Kind of that average: sma, ema, dema or wma. Default ema
   * @param src - Price read from each candle: open, high, low, close, hl2, hlc3 or ohlc4. Default close
   */
  constructor({ period = 13, maType = 'ema', src }: IndicatorRegistry['EFI']['input'] = {}) {
    super();
    checkInteger('EFI', 'period', period);
    checkOneOf('EFI', 'maType', maType, MOVING_AVERAGE_TYPES);
    checkInputSource('EFI', src);
    // The average is fed the force as a number, through update, and reads no candle. It used to get it as the close of a made-up
    // candle, and EFI's src too: with sma or ema and any src but close it read a field that candle lacked, and smoothed was NaN forever
    this.ma = new MOVING_AVERAGES[maType]({ period });
    this.getPrice = getInputSource(src);
  }

  public onNewCandle(candle: Candle): void {
    // The force used to take the close whatever src said
    const price = this.getPrice(candle);
    if (isNil(this.prevPrice)) {
      this.prevPrice = price;
      return;
    }

    const fi = (price - this.prevPrice) * candle.volume;
    this.prevPrice = price;

    this.ma.update(fi);
    const smoothed = this.ma.getResult();

    // The force index alone went out while its moving average warmed up
    if (!isNil(smoothed)) this.result = { fi, smoothed };
  }
}
