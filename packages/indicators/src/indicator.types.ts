// Type imports, here and in indicator.ts that imports this file: the map's file loads the moving averages, which extend Indicator, so
// a value import would close a cycle
import type { MOVING_AVERAGES } from './movingAverages/movingAverages.const';

export type IndicatorNames = keyof IndicatorRegistry;
export type IndicatorParameters<T extends IndicatorNames> = IndicatorRegistry[T]['input'];
export type MovingAverageClasses = InstanceType<(typeof MOVING_AVERAGES)[MovingAverageTypes]>;
export type MovingAverageTypes = keyof typeof MOVING_AVERAGES;
