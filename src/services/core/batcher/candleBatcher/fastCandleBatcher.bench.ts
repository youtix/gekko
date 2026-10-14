import { ONE_MINUTE } from '@constants/time.const';
import { Candle } from '@models/candle.types';
import { bench } from '@utils/bench/bench.mock';
import { addPrecise } from '@utils/math/math.utils';
import { describe } from 'vitest';
import { FastCandleBatcher } from './fastCandleBatcher';

// One day of 1-minute candles with exchange-like volumes (up to 8 decimals)
const start = Date.UTC(2024, 0, 1);
const candles: Candle[] = Array.from({ length: 1440 }, (_, i) => ({
  start: start + i * ONE_MINUTE,
  open: 100,
  high: 101,
  low: 99,
  close: 100.5,
  volume: Math.round(Math.random() * 1e8 * (1 + (i % 7))) / 1e8,
}));

describe('FastCandleBatcher, one day of 1-minute candles into 1h candles', () => {
  bench('FastCandleBatcher.addCandle', () => {
    const batcher = new FastCandleBatcher(60);
    for (const candle of candles) batcher.addCandle(candle);
  });

  // The volume sum as it was before the scaled accumulator: one addPrecise (two toString and split) per candle
  bench('volume summed with addPrecise per candle (previous implementation)', () => {
    let volume = 0;
    for (const candle of candles) volume = candle.start % (60 * ONE_MINUTE) === 0 ? candle.volume : addPrecise(volume, candle.volume);
  });
});
