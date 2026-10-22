import { checkInputSource, checkInteger } from '../../indicator.helper';
import { WilderSmoothing } from '../wilderSmoothing/wilderSmoothing.indicator';

/**
 * The smoothed moving average is Wilder's smoothing under another name. It used to be a second copy of the same recurrence,
 * seeded through an SMA, so the two could drift apart; it now is that class and only declares its own input.
 */
export class SMMA extends WilderSmoothing {
  /**
   * @param period - Candles of the first mean, and the divisor of the smoothing: a whole number, at least 1. Required
   * @param src - Price read from each candle: open, high, low, close, hl2, hlc3 or ohlc4. Default close
   */
  constructor(parameters: IndicatorRegistry['SMMA']['input']) {
    // Checked before WilderSmoothing's own checks, so that the message names SMMA, and so that a missing period is refused, as SMMA
    // declares it required, rather than take WilderSmoothing's default of 14
    checkInteger('SMMA', 'period', parameters?.period);
    checkInputSource('SMMA', parameters?.src);
    super(parameters);
  }
}
