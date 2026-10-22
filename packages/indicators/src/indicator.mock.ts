import type { Indicator } from './indicator';
import { Candle } from '@gekko/shared/models/candle.types';
import { mapValues } from 'lodash-es';
import { expect } from 'vitest';

/** A cell of an indicator's table: null while the indicator is not ready, else its number, or its object or array of numbers */
type ExpectedResult = null | number | ExpectedResult[] | { [field: string]: ExpectedResult };

/**
 * What toEqual must find for an indicator's result: null exactly where `expected` is null, and each number of `expected` within
 * `precision` digits, field by field in an object or an array. The tables used to assert with toBeCloseTo, which reads null as 0: a
 * null row passed when the indicator published 0 while it warmed up, as TRIX did, and a row of 0 passed when it published null.
 * expect.closeTo matches numbers only. As with it, a NaN matches nothing: assert one with toBe.
 *
 * `precision` follows from the largest magnitude the table works at, that of its values or of the prices they come from when those
 * are larger: the most digits whose tolerance, 10^-precision / 2, spans 16 ulps of it, room for the float operations to run in another
 * order, which moves a value by a few ulps. From 16 to 256 that is 12, then 11 up to 2048, 10 up to 16384 and 9 up to 262144. Most
 * tables took 13 whatever their magnitude, which from 256 on is bit equality: an ulp of 256 is 5.7e-14, more than the tolerance of
 * 5e-14, so EFI's and OBV's values had to match to the last bit. A value that divides by a small difference of prices, as CCI's on a
 * window almost flat, carries their rounding further: its table says how far.
 */
export const approximately = (expected: ExpectedResult, precision: number): unknown => {
  if (expected === null) return null;
  if (Array.isArray(expected)) return expected.map(value => approximately(value, precision));
  if (typeof expected === 'object') return mapValues(expected, value => approximately(value, precision));
  return expect.closeTo(expected, precision);
};

/** A minute without a trade, as an exchange reports it and as the gap filler makes it up: flat at the last close, volume 0 */
const noTrade = (price: number): Candle => ({ start: 0, open: price, high: price, low: price, close: price, volume: 0 });
/** A minute whose trades all went through at one price: no range */
const singleTrade = (price: number, volume: number): Candle => ({ start: 0, open: price, high: price, low: price, close: price, volume });

/**
 * The candles of an illiquid market. The 39 candles of the value tables each open at the last close, trade on both sides of it and
 * have a volume, so until these no test met a gap, a tie, a candle without range or a volume of 0, and the code for them could go
 * without a test failing. A short timeframe on a thin pair feeds them all, as does the gap filler, which makes up a flat candle without
 * volume for each minute it fills. From the second candle on, the true ranges are 0, 0, 4, 5, 4, 0, 0, 2, 2, 3, and the moves up / down
 * (+DM / −DM) 0/0, 0/0, 4/0, 0/4, 2/0, 0/0, 0/0, 0/0 (a tie), 0/1, 3/0.
 */
export const illiquidCandles: Candle[] = [
  noTrade(10),
  noTrade(10),
  noTrade(10),
  // A gap up: from its high to the last close, its true range is 4 over a range of 2
  { start: 0, open: 12, high: 14, low: 12, close: 13, volume: 4 },
  // A gap down: from its low to the last close, 5 over a range of 3
  { start: 0, open: 11, high: 11, low: 8, close: 9, volume: 6 },
  // A single trade away from the last close: 4 without any range
  singleTrade(13, 1),
  noTrade(13),
  noTrade(13),
  // As far above the last high as below the last low, which counts for neither move, closing unchanged on a volume of 3
  { start: 0, open: 13, high: 14, low: 12, close: 13, volume: 3 },
  singleTrade(11, 2),
  { start: 0, open: 11, high: 14, low: 11, close: 13, volume: 5 },
];

/** The result after each candle, copied, so that an object result the indicator changes later cannot change an earlier one */
export const resultsOf = (indicator: Indicator, candles: Candle[]) =>
  candles.map(candle => {
    indicator.onNewCandle(candle);
    return structuredClone(indicator.getResult());
  });
