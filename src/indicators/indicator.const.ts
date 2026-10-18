import { Candle } from '@models/candle.types';
import { hl2, hlc3, ohlc4 } from '@helpers/candle/candle.helper';

export const INPUT_SOURCES = {
  open: (candle: Candle) => candle.open,
  high: (candle: Candle) => candle.high,
  low: (candle: Candle) => candle.low,
  close: (candle: Candle) => candle.close,
  hl2,
  hlc3,
  ohlc4,
} as const;
