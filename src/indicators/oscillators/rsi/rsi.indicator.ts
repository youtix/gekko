import { Indicator } from '@indicators/indicator';
import { checkInputSource, checkInteger, getInputSource } from '@indicators/indicator.utils';
import { WilderSmoothing } from '@indicators/movingAverages/wilderSmoothing/wilderSmoothing.indicator';
import { Candle } from '@models/candle.types';
import { isNil } from 'lodash-es';

export class RSI extends Indicator<'RSI'> {
  private wilderGain: WilderSmoothing;
  private wilderLoss: WilderSmoothing;
  private prevPrice?: number;
  private getPrice: (candle: Candle) => number;

  /**
   * @param period - Period of the smoothed gains and losses: a whole number, at least 2, TA-Lib's minimum, since with 1 the averages
   * are the last gain and the last loss, and the RSI 100 on a rise and 0 on any other candle, an unchanged close included. Default 14
   * @param src - Price read from each candle: open, high, low, close, hl2, hlc3 or ohlc4. Default close
   */
  constructor({ period = 14, src }: IndicatorRegistry['RSI']['input'] = {}) {
    super();
    // Period 1 used to be accepted: an RSI strategy read every unchanged close, the flat candles that fill a gap included, as the most
    // oversold reading, and bought on a market that did not move
    checkInteger('RSI', 'period', period, 2, 'the RSI of a single change is 100 on a rise, and 0 on a fall or an unchanged close');
    checkInputSource('RSI', src);
    this.wilderGain = new WilderSmoothing({ period });
    this.wilderLoss = new WilderSmoothing({ period });
    this.getPrice = getInputSource(src);
  }

  public onNewCandle(candle: Candle): void {
    const price = this.getPrice(candle);
    if (isNil(this.prevPrice)) {
      this.prevPrice = price;
      return;
    }

    const change = price - this.prevPrice;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    this.wilderGain.update(gain);
    this.wilderLoss.update(loss);

    const avgGain = this.wilderGain.getResult();
    const avgLoss = this.wilderLoss.getResult();

    if (!isNil(avgGain) && !isNil(avgLoss)) {
      const total = avgGain + avgLoss;
      this.result = total === 0 ? 0 : (avgGain / total) * 100;
    }

    this.prevPrice = price;
  }
}
