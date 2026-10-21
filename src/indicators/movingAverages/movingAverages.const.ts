import { DEMA } from './dema/dema.indicator';
import { EMA } from './ema/ema.indicator';
import type { MovingAverage } from './movingAverage';
import { SMA } from './sma/sma.indicator';
import { WMA } from './wma/wma.indicator';

/**
 * The moving averages an indicator can smooth with, by the name its maType parameter takes. A new kind is added here only: the names
 * the maType checks accept, MovingAverageTypes and MovingAverageClasses derive from this map. BollingerBands, EFI and Stochastic used
 * to hold a copy each, where a wrong class compiled unnoticed.
 * No moving average may import this file, even indirectly. In indicator.const.ts, which they import through indicator.helper.ts, the map
 * would close a cycle: a moving average loaded first would throw "Cannot access 'SMA' before initialization" under Bun, and be missing
 * from the map under vitest.
 * Each kind is a MovingAverage built from a period: the indicators that smooth with one feed it their values through update.
 */
export const MOVING_AVERAGES = {
  sma: SMA,
  ema: EMA,
  dema: DEMA,
  wma: WMA,
} as const satisfies Record<string, new (parameters: { period: number }) => MovingAverage>;

/** The names a maType parameter takes, in the order the refusals list them */
export const MOVING_AVERAGE_TYPES = Object.keys(MOVING_AVERAGES) as readonly (keyof typeof MOVING_AVERAGES)[];
