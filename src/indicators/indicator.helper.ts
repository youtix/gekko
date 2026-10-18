import { GekkoError } from '@errors/gekko.error';
import { Candle } from '@models/candle.types';
import { InputSources } from '@models/inputSources.types';
import { INPUT_SOURCES } from './indicator.const';
import type { IndicatorNames } from './indicator.types';

/**
 * The price an indicator reads from each candle, named by its `src` parameter, or the close when it names none. Every indicator with a
 * `src` reads it through here, so that they agree on it: DEMA, TEMA, WMA and Wilder's smoothing used to ignore it.
 */
export const getInputSource = (src: InputSources = 'close'): ((candle: Candle) => number) => INPUT_SOURCES[src];

/*
 * Parameter checks, which every indicator constructor runs before it builds anything. Indicators used to take any parameter and fail
 * later, silently or cryptically: a missing or fractional period fell back to a default, never seeded, or gave NaN or ±Infinity on
 * every candle, swapped MACD periods gave the opposite line, an unknown src threw `getPrice is not a function` at the first candle and
 * an unknown maType "undefined is not a constructor". Each check throws a GekkoError that names the indicator, the parameter and what
 * it accepts. An indicator built on others checks its own parameters first, so that the message names the one the strategy passed.
 */

const INPUT_SOURCE_NAMES = Object.keys(INPUT_SOURCES);

const show = (value: unknown) => (typeof value === 'string' ? JSON.stringify(value) : String(value));

const refuse = (indicator: IndicatorNames, problem: string, why?: string): never => {
  throw new GekkoError('strategy', `Indicator ${indicator}: ${problem}${why ? ` (${why})` : ''}`);
};

/** A number of candles, or of averages in a ribbon: a whole number, at least `minimum`, 1 unless the indicator needs more values */
export const checkInteger = (indicator: IndicatorNames, key: string, value: unknown, minimum = 1, why?: string) => {
  if (!Number.isInteger(value) || (value as number) < minimum)
    refuse(indicator, `${key} must be a whole number, at least ${minimum}, got ${show(value)}`, why);
};

/** A finite number, at least or above a bound */
export const checkNumber = (indicator: IndicatorNames, key: string, value: unknown, bound: { atLeast: number } | { above: number }) => {
  const isAbove = 'above' in bound;
  const isWithin = typeof value === 'number' && (isAbove ? value > bound.above : value >= bound.atLeast);
  if (!isWithin || !Number.isFinite(value))
    refuse(indicator, `${key} must be a number, ${isAbove ? `above ${bound.above}` : `at least ${bound.atLeast}`}, got ${show(value)}`);
};

/** One of the accepted names, given as they are spelt in the list */
export const checkOneOf = (indicator: IndicatorNames, key: string, value: unknown, accepted: readonly string[]) => {
  if (!accepted.includes(value as string)) refuse(indicator, `${key} must be one of ${accepted.map(show).join(', ')}, got ${show(value)}`);
};

/** The price source named by `src`, or none, which means the close */
export const checkInputSource = (indicator: IndicatorNames, src: unknown) => {
  if (src !== undefined) checkOneOf(indicator, 'src', src, INPUT_SOURCE_NAMES);
};

/** Two parameters in order, the first strictly below the second; `why` says what the reverse order would compute */
export const checkBelow = (indicator: IndicatorNames, lowKey: string, low: number, highKey: string, high: number, why: string) => {
  if (!(low < high)) refuse(indicator, `${lowKey} must be below ${highKey}, got ${lowKey} ${low} and ${highKey} ${high}`, why);
};

/** Two parameters in order, the first at most the second, so that they may be equal; `why` says what the reverse order would compute */
export const checkAtMost = (indicator: IndicatorNames, lowKey: string, low: number, highKey: string, high: number, why: string) => {
  if (!(low <= high)) refuse(indicator, `${lowKey} must be at most ${highKey}, got ${lowKey} ${low} and ${highKey} ${high}`, why);
};
