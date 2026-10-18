import { ONE_MINUTE } from '@constants/time.const';
import { getCandleTimeOffset } from '@helpers/candle/candle.helper';
import { CandleSize } from './candleBatcher.types';

/**
 * Tells whether the 1-minute candle starting at `start` is the last one of a timeframe candle of `candleSize` minutes: the next minute
 * starts a timeframe candle. Read on the calendar of getCandleTimeOffset, the one getCandleStart places the warmup and the backtest
 * candles on: a second copy of it here could be changed alone, and the batcher would then close its candles off their boundaries.
 */
export const isTimeframeCandleClose = (candleSize: CandleSize, start: EpochTimeStamp): boolean =>
  getCandleTimeOffset(candleSize, start + ONE_MINUTE) === 0;
