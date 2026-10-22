import { map, mean } from 'lodash-es';
import { countDecimals, round, shiftDecimalPoint } from './round.utils';

/** The significant digits a double keeps of any decimal: past them, a number computed in binary carries only noise */
const SIGNIFICANT_DIGITS = 15;

const valuesMinusMeanSquared = (values: number[] = []) => {
  const average = mean(values);
  return map(values, val => Math.pow(val - average, 2));
};

export const stdev = (vals: number[] = []) => {
  // average squared deviation from mean
  return Math.sqrt(mean(valuesMinusMeanSquared(vals)));
};

/**
 * a + b as the two are written: the double nearest to the sum of the decimals String gives them, where binary addition can come out an
 * ulp off it. 0.1 + 0.2 is 0.3, not 0.30000000000000004, and 2.5 - 2.2 is 0.3, not 0.2999999999999998, truncated to 0.29 on a step of
 * 0.01. For the amounts and prices that must come out as decimals: what an order leaves after its fills, the SELLs the Trader counts,
 * the prices of a grid. Worked out in decimal while both and their sum, scaled to the decimals of the longer, are safe integers (below
 * 2 ** 53); beyond, a + b. Scaled on the digits String writes: by a binary product, values of 16 or 17 significant digits would come
 * back further off than a + b (123456.78901234567 + 1e-8), and of over 308 decimals as NaN. The sum is exact up to 15 significant
 * digits. At 16 the result is still the double nearest to it, but String can write that double a unit of its last decimal off, and the
 * next call adds to that neighbour: a change below an ulp can be lost (an 8-decimal balance from 67.1 M to 90 M units).
 */
export const addPrecise = (a: number, b: number): number => {
  const decimals = Math.max(countDecimals(a), countDecimals(b));
  const scaledA = shiftDecimalPoint(a, decimals);
  const scaledB = shiftDecimalPoint(b, decimals);
  const scaledSum = scaledA + scaledB;
  if (!Number.isSafeInteger(scaledA) || !Number.isSafeInteger(scaledB) || !Number.isSafeInteger(scaledSum)) return a + b;
  return shiftDecimalPoint(scaledSum, -decimals);
};

/**
 * a × b as the two are written: the binary product, which can come out an ulp off the product of their decimals (100.01 × 0.0004 is
 * 0.040004000000000005), rounded to the decimals of a and b added up (0.040004). That is the double nearest to the product while the
 * product, so written, has 15 significant digits or fewer, subnormals aside (5e-324 × 0.5 is 0). At 16 the rounding can land a unit of
 * the last decimal off the product, farther than a × b: 5.65849689 × 89716.24 is 507659.0650224936, 507659.0650224937 here and
 * 507659.06502249365 in binary. Beyond, a × b.
 */
export const multiplyPrecise = (a: number, b: number): number => round(a * b, countDecimals(a) + countDecimals(b));

/**
 * value to 15 significant digits (see SIGNIFICANT_DIGITS): the decimal it stands for, without the noise of the binary arithmetic that
 * made it, 0.07 for 0.06999999999999999. For a quotient, which no helper here works out exactly (a mean, a fee rate), and for a figure
 * made in binary upstream. A value of more significant digits loses them: 100.66666666666667 is 100.666666666667. The double itself is
 * rounded (toPrecision, a tie away from zero), not the shortest decimal String writes, which can end in a 5 that is no tie: 4000000 / 7,
 * written 571428.5714285715, is 571428.57142857147…, so 571428.571428571. NaN, an infinite value and 0 are given back as they are.
 */
export const toSignificantDigits = (value: number): number => {
  if (!Number.isFinite(value) || value === 0) return value; // toPrecision writes -0 as '0'
  return Number(value.toPrecision(SIGNIFICANT_DIGITS));
};

/** Number.isFinite as a type guard. lodash's isNumber lets NaN through, which fails every comparison: a strategy silently never trades */
export const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);

/**
 * A finite number above 0: what an order's price, amount and cost must be, and a market's bound or step to be one. NaN, ±Infinity, 0,
 * a negative number, undefined and a quoted number are not (Number.isFinite does not coerce). The order layer, the simulator, the
 * Trader and the StrategyManager each kept a copy of their own, which a change to one would not have reached.
 */
export const isFinitePositive = (value: unknown): value is number => isFiniteNumber(value) && value > 0;

/**
 * Math.sign(a - b), NaN if either is NaN, but 0 when a and b differ by at most `tolerance` times the larger magnitude. Below a tolerance
 * of 1 (0.5 under 2.3e-308) only 0 equals 0, and an infinite value only itself. Values equal in exact arithmetic come out a few ulps
 * apart, either way, once computed apart (a flat window's price and its running-sum SMA; p and (p + p + p) / 3, for 15 % of prices):
 * compared exactly, they would be ordered by that noise. The default tolerance, 1e-9, is far above it (the running sum drifts 1e-15 of
 * the mean in a thousand candles, 2e-13 in ten million, 19 years of minutes, 1e-10 if the price fell a thousandfold meanwhile) and far
 * below a tick, 1e-7 of the price or more (0.01 on 100000): values within it are under a hundredth of a tick apart, a touch, not a cross.
 */
export const compareWithTolerance = (a: number, b: number, tolerance = 1e-9): number => {
  if (a === b) return 0;
  const difference = a - b;
  // Infinity times the tolerance is Infinity again: an infinite value would be within the tolerance of any finite one
  if (Number.isFinite(difference) && Math.abs(difference) <= tolerance * Math.max(Math.abs(a), Math.abs(b))) return 0;
  return Math.sign(difference);
};
