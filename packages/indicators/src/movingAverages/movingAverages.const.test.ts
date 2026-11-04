import { describe, expect, it } from 'vitest';
import { DEMA } from './dema/dema.indicator';
import { EMA } from './ema/ema.indicator';
import { MOVING_AVERAGE_TYPES, MOVING_AVERAGES } from './movingAverages.const';
import { SMA } from './sma/sma.indicator';
import { WMA } from './wma/wma.indicator';

// DEMA is loaded before the map, as when a moving average is the first module loaded. A map in a file the moving averages import, such
// as indicator.const.ts, would then be built before DEMA is defined: without it here, and with a ReferenceError under Bun
describe('MOVING_AVERAGES', () => {
  it.each`
    maType    | average
    ${'sma'}  | ${SMA}
    ${'ema'}  | ${EMA}
    ${'dema'} | ${DEMA}
    ${'wma'}  | ${WMA}
  `('should build $average.name for maType $maType', ({ maType, average }) => {
    expect(MOVING_AVERAGES[maType as keyof typeof MOVING_AVERAGES]).toBe(average);
  });

  it('should take its names as the maType names, in its order', () => {
    expect(MOVING_AVERAGE_TYPES).toEqual(['sma', 'ema', 'dema', 'wma']);
  });
});
