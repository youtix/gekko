import { checkAtMost, checkNumber } from '@indicators/indicator.helper';
import { Candle } from '@models/candle.types';
import { Indicator } from '../../indicator';

export class PSAR extends Indicator<'PSAR'> {
  private acceleration: number;
  private maxAcceleration: number;
  private prevCandle?: Candle;
  private sar: number;
  private af: number;
  private ep: number;
  private isLong: boolean;

  /**
   * @param acceleration - First acceleration factor, and its increase at each new extreme point: a number above 0, at most
   * maxAcceleration. Default 0.02
   * @param maxAcceleration - Largest acceleration factor: a number at least acceleration; equal to it, the factor is fixed. Default 0.2
   */
  constructor({ acceleration = 0.02, maxAcceleration = 0.2 }: IndicatorRegistry['PSAR']['input'] = {}) {
    super();
    checkNumber('PSAR', 'acceleration', acceleration, { above: 0 });
    checkNumber('PSAR', 'maxAcceleration', maxAcceleration, { above: 0 });
    // The factor used to restart above its maximum after every reversal. TA-Lib lowers the acceleration to the maximum, which fixes the
    // factor; refused instead, since equal values ask for a fixed factor explicitly
    checkAtMost(
      'PSAR',
      'acceleration',
      acceleration,
      'maxAcceleration',
      maxAcceleration,
      'the factor would restart above its maximum after every reversal',
    );
    this.acceleration = acceleration;
    this.maxAcceleration = maxAcceleration;
    this.af = this.acceleration;
    this.sar = NaN;
    this.ep = NaN;
    this.isLong = true;
  }

  private calcSar(sar: number, ep: number, af: number) {
    return (ep - sar) * af + sar;
  }

  public onNewCandle(candle: Candle) {
    if (!this.prevCandle) {
      this.prevCandle = candle;
      return;
    }

    if (isNaN(this.sar)) {
      const { high: prevHigh, low: prevLow } = this.prevCandle;
      // As in TA-Lib, short when the candle's −DM is positive: its low fell from the previous candle's, and by more than its high rose.
      // That move came from a MinusDM of period 1 kept for the whole run, which a restart after a NaN SAR, from a non-finite price,
      // read from the candle of the previous start
      const down = prevLow - candle.low;
      this.isLong = !(down > 0 && down > candle.high - prevHigh);
      this.sar = this.isLong ? prevLow : prevHigh;
      this.ep = this.isLong ? candle.high : candle.low;
      this.prevCandle = candle;
    }

    const { high: prevHigh, low: prevLow } = this.prevCandle;
    const { high: currentHigh, low: currentLow } = candle;

    if (this.isLong) {
      if (currentLow <= this.sar) {
        // Switch to short
        this.isLong = false;
        this.result = Math.max(this.ep, prevHigh, currentHigh);
        this.af = this.acceleration;
        this.ep = currentLow;
        this.sar = Math.max(this.calcSar(this.result, this.ep, this.af), prevHigh, currentHigh);
      } else {
        this.result = this.sar;
        if (currentHigh > this.ep) {
          this.ep = currentHigh;
          this.af = Math.min(this.af + this.acceleration, this.maxAcceleration);
        }
        this.sar = Math.min(this.calcSar(this.sar, this.ep, this.af), prevLow, currentLow);
      }
    } else {
      if (currentHigh >= this.sar) {
        // Switch to long
        this.isLong = true;
        this.result = Math.min(this.ep, prevLow, currentLow);
        this.af = this.acceleration;
        this.ep = currentHigh;
        this.sar = Math.min(this.calcSar(this.result, this.ep, this.af), prevLow, currentLow);
      } else {
        this.result = this.sar;
        if (currentLow < this.ep) {
          this.ep = currentLow;
          this.af = Math.min(this.af + this.acceleration, this.maxAcceleration);
        }
        this.sar = Math.max(this.calcSar(this.sar, this.ep, this.af), prevHigh, currentHigh);
      }
    }
    this.prevCandle = candle;
  }
}
