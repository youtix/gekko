/**
 * @fileoverview Financial and statistical utility functions for trading analysis.
 * All functions are pure and stateless. Five throw an Error on an input they cannot measure: calculateElapsedYears on a period that
 * ends before it starts, calculateTotalReturnPct and calculateAnnualizedReturnPct on a start equity of 0 or less, the latter on a number
 * of years of 0 or less too, and calculateMarketReturnPct and calculateExposurePct on a start price or a period of 0 or less. The others
 * return 0, null or an empty array for an input without anything to measure, or skip such an input.
 *
 * The percentages a report shows (the total, annualized and market returns, the alpha, the max drawdown, the exposure, the win rate)
 * are worked out in decimal (see toPercent): the reporters round them to 2 decimals, most of them down, and wrote 0 % for the 0.01 % a
 * binary quotient made 0.009999999999998899.
 */

import { BOOKED_CURRENCY_UNIT } from '@constants/order.const';
import { EquitySnapshot } from '@models/event.types';
import { addPrecise, compareWithTolerance, stdev, toSignificantDigits } from '@utils/math/math.utils';
import { shiftDecimalPoint } from '@utils/math/round.utils';

// ============================================================================
// TYPES
// ============================================================================

/** What an annualized ratio weighs (see calculateAnnualizedRatio) */
export interface RatioParams {
  /** The returns of the period, in %: one per round trip or per timeframe candle */
  returns: number[];
  /** The annualized return of the period, in % */
  yearlyProfit: number;
  /** The yearly return of a riskless investment, in % (e.g., 1 for 1 %) */
  riskFreeReturn: number;
  /** The period, in years */
  elapsedYears: number;
}

/** The drawdowns of an equity curve (see calculateDrawdowns) */
export interface Drawdowns {
  /** The largest fall from a peak, in % of the peak */
  maxDrawdownPct: number;
  /** The longest time from a peak to the sample that gets back to it, or to the last sample, in milliseconds */
  longestDrawdownMs: number;
}

// ============================================================================
// TIME CALCULATIONS
// ============================================================================

/**
 * The instant `years` years after date, in UTC: the same time on the same day of the same month, a Feb 29 falling on Feb 28 in a year
 * without one
 */
const addUTCYears = (date: number, years: number): number => {
  const from = new Date(date);
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const day = from.getUTCDate();
  const timeOfDay = date - Date.UTC(year, month, day);
  // Day 0 of a month is the last day of the month before
  const lastDay = new Date(Date.UTC(year + years, month + 1, 0)).getUTCDate();
  return Date.UTC(year + years, month, Math.min(day, lastDay)) + timeOfDay;
};

/**
 * Calculates elapsed years between two dates, in UTC: the whole years from startDate to its last anniversary at or before endDate,
 * plus the time since that anniversary over the length of the year it begins, to the next one (365 or 366 days). An anniversary is the
 * same time on the same day of a later year, a Feb 29 falling on Feb 28 in a year without one. Counted in the machine's time zone, as
 * date-fns' addYears and differenceInYears count, a year from a start between the two dates of a daylight saving change came out an
 * hour off, one from a local Feb 29 a day off, and the years of a period from a Feb 29 fell back a day's worth as its end reached the
 * next Feb 29.
 *
 * @param startDate - Start timestamp (epoch milliseconds)
 * @param endDate - End timestamp (epoch milliseconds)
 * @returns Elapsed time in years (fractional), the same on every machine and growing with endDate: 182/366 from 2024-01-01 to
 * 2024-07-01, 1 from 2024-02-29 to 2025-02-28
 * @throws Error if endDate is before startDate
 */
export const calculateElapsedYears = (startDate: number, endDate: number): number => {
  if (endDate < startDate) throw new Error('endDate must be greater than or equal to startDate');

  const calendarYears = new Date(endDate).getUTCFullYear() - new Date(startDate).getUTCFullYear();
  const fullYears = addUTCYears(startDate, calendarYears) > endDate ? calendarYears - 1 : calendarYears;
  const yearStart = addUTCYears(startDate, fullYears);
  // The next anniversary is counted from startDate: counted from a Feb 28 that stands for a Feb 29, it would miss the Feb 29 after
  return fullYears + (endDate - yearStart) / (addUTCYears(startDate, fullYears + 1) - yearStart);
};

// ============================================================================
// RETURN CALCULATIONS
// ============================================================================

/**
 * part as a percentage of whole: part moved two places in decimal, divided once, and rid of the noise of that division (see
 * toSignificantDigits)
 */
const toPercent = (part: number, whole: number): number => toSignificantDigits(shiftDecimalPoint(part, 2) / whole);

/**
 * Calculates total return as a percentage.
 *
 * @param currentEquity - Current portfolio value
 * @param startEquity - Initial portfolio value
 * @returns Total return percentage (e.g., 25.5 for 25.5%)
 * @throws Error if startEquity is zero or negative
 */
export const calculateTotalReturnPct = (currentEquity: number, startEquity: number): number => {
  if (startEquity <= 0) throw new Error('startEquity must be greater than zero');
  // The change first, in decimal: (1000.2 / 1000) * 100 - 100 left the binary noise of 100.02 on 0.02, 0.01999999999999602
  return toPercent(addPrecise(currentEquity, -startEquity), startEquity);
};

/**
 * Calculates annualized return percentage: the total return (see calculateTotalReturnPct) over the elapsed years, worked out from the
 * equities, its change in decimal and rounded once. Worked out from the total return, already rounded to 15 significant digits, it had
 * lost a digit that could not come back: a gain of 40 on 300,000 over a day of 2024, 0.0133333333333333 % × 366, made
 * 4.87999999999999 % a year for 4.88 %, which the reporters, rounding down, wrote 4.87 %.
 *
 * @param currentEquity - Current portfolio value
 * @param startEquity - Initial portfolio value
 * @param elapsedYears - Time period in years
 * @returns Annualized return percentage (e.g., 50 for a gain of 100% over 2 years)
 * @throws Error if startEquity or elapsedYears is zero or negative
 */
export const calculateAnnualizedReturnPct = (currentEquity: number, startEquity: number, elapsedYears: number): number => {
  if (startEquity <= 0) throw new Error('startEquity must be greater than zero');
  if (elapsedYears <= 0) throw new Error('elapsedYears must be greater than zero');
  // Both divisions before the one rounding: 0.3 % over 3 years is 0.1 % a year, 0.09999999999999999 in binary
  return toSignificantDigits(shiftDecimalPoint(addPrecise(currentEquity, -startEquity), 2) / startEquity / elapsedYears);
};

/**
 * Calculates market return percentage (buy-and-hold benchmark).
 *
 * @param endPrice - Price at end of period
 * @param startPrice - Price at start of period
 * @returns Market return percentage
 * @throws Error if startPrice is zero or negative
 */
export const calculateMarketReturnPct = (endPrice: number, startPrice: number): number => {
  if (startPrice <= 0) throw new Error('startPrice must be greater than zero');
  return toPercent(addPrecise(endPrice, -startPrice), startPrice);
};

/**
 * Calculates alpha (excess return over benchmark).
 * Returns equal but for the noise of the arithmetic that made them (see compareWithTolerance) give 0: the return of a portfolio holding
 * the benchmark asset alone, worked out from its equities, came out 1.3e-14 below the market return, and the alpha was written -0.01 %.
 *
 * @param totalReturnPct - Strategy's total return percentage
 * @param marketReturnPct - Benchmark (market) return percentage
 * @returns Alpha as percentage points
 */
export const calculateAlpha = (totalReturnPct: number, marketReturnPct: number): number => {
  return compareWithTolerance(totalReturnPct, marketReturnPct) === 0 ? 0 : addPrecise(totalReturnPct, -marketReturnPct);
};

/**
 * Calculates the returns for each period based on equity snapshots. A change of less than a booked unit is no return (see
 * BOOKED_CURRENCY_UNIT).
 *
 * @param snapshots - Array of equity snapshots
 * @returns Array of percentage returns
 */
export const calculateReturns = (snapshots: EquitySnapshot[]): number[] => {
  const returns: number[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1].totalValue;
    const curr = snapshots[i].totalValue;
    if (prev > 0) returns.push(Math.abs(curr - prev) < BOOKED_CURRENCY_UNIT ? 0 : ((curr - prev) / prev) * 100);
  }
  return returns;
};

// ============================================================================
// EXPOSURE & WIN RATE
// ============================================================================

/**
 * Calculates exposure percentage (time in market).
 *
 * @param exposureMs - Total time exposed to market (milliseconds)
 * @param totalMs - Total period duration (milliseconds)
 * @returns Exposure as percentage (0-100)
 * @throws Error if totalMs is zero or negative
 */
export const calculateExposurePct = (exposureMs: number, totalMs: number): number => {
  if (totalMs <= 0) throw new Error('totalMs must be greater than zero');
  // 30.24 s of a day is 0.035 %, 0.034999999999999996 in binary, which the reporters rounded half even to 0.03 %
  return toPercent(exposureMs, totalMs);
};

/**
 * Calculates win rate (percentage of profitable trades).
 *
 * @param winningTrades - Number of profitable trades
 * @param totalTrades - Total number of trades
 * @returns Win rate as percentage, or null if no trades
 */
export const calculateWinRate = (winningTrades: number, totalTrades: number): number | null => {
  if (totalTrades <= 0) return null;
  return toPercent(winningTrades, totalTrades);
};

// ============================================================================
// RISK METRICS
// ============================================================================

/**
 * Calculates the volatility of the returns: their population standard deviation (see stdev), 0 without a return, and 0 for returns all
 * equal within compareWithTolerance. Their deviation was noise then, from lodash's mean (0.10000000000000002 for 0.1, 0.1 and 0.1) or
 * from the arithmetic that made them (0.1 and 0.09999999999999763 for equities of 1000, 1001 and 1002.001), and a Sharpe ratio divided
 * by it came out at 6.2e17.
 *
 * @param returns - Array of percentage returns per trade/period
 * @returns Standard deviation of the returns, in percentage points; NaN for a return that is not a number
 */
export const calculateVolatility = (returns: number[]): number => {
  if (!returns.length) return 0;

  // Math.min and Math.max, not comparisons, which a NaN return fails: it would be passed over, and the others found equal
  let lowest = returns[0];
  let highest = returns[0];
  for (const value of returns) {
    lowest = Math.min(lowest, value);
    highest = Math.max(highest, value);
  }
  return compareWithTolerance(highest, lowest) === 0 ? 0 : stdev(returns);
};

/**
 * Calculates downside deviation (volatility of negative returns only).
 * Uses root mean square of negative returns.
 *
 * @param profits - Array of profit percentages per trade
 * @returns Downside deviation as percentage
 */
export const calculateDownsideDeviation = (profits: number[]): number => {
  if (!profits.length) return 0;

  const sumSquaredDownside = profits.reduce((sum, profit) => (profit < 0 ? sum + Math.pow(profit, 2) : sum), 0);

  return Math.sqrt(sumSquaredDownside / profits.length);
};

/**
 * Extracts the top N largest Maximum Adverse Excursions (MAE).
 *
 * @param maes - Array of MAE values from round trips
 * @param limit - Maximum number of MAEs to return (default: 10)
 * @returns Sorted array of top MAE values (descending)
 */
export const extractTopMAEs = (maes: number[], limit: number = 10): number[] => {
  return maes
    .filter((value): value is number => Number.isFinite(value) && value >= 0)
    .sort((left, right) => right - left)
    .slice(0, limit);
};

/**
 * Calculates an annualized ratio: the yearly profit in excess of the risk-free return, over a deviation of the returns annualized by
 * sqrt(observations per year), the observations per year being the number of returns over the elapsed years. The Sharpe ratio weighs
 * the volatility of the returns (calculateVolatility), the Sortino ratio their downside deviation (calculateDownsideDeviation).
 *
 * @param deviation - The deviation of params.returns the ratio weighs
 * @param params.returns - Array of percentage returns per trade/period
 * @param params.yearlyProfit - Annualized profit percentage
 * @param params.riskFreeReturn - Risk-free rate of return (e.g., 1 for 1%)
 * @param params.elapsedYears - Total elapsed time in years
 * @returns Annualized ratio, or 0 when there is no return, no elapsed time or no deviation (0, or NaN): the ratio is undefined then,
 * and 0 is reported instead
 */
export const calculateAnnualizedRatio = (
  deviation: number,
  { returns, yearlyProfit, riskFreeReturn, elapsedYears }: RatioParams,
): number => {
  if (!returns.length || elapsedYears <= 0) return 0;

  const annualizedDeviation = deviation * Math.sqrt(returns.length / elapsedYears);
  return annualizedDeviation ? (yearlyProfit - riskFreeReturn) / annualizedDeviation : 0;
};

/**
 * Calculates the annualized Sharpe ratio (see calculateAnnualizedRatio).
 * Sharpe ratio measures risk-adjusted return using the volatility of all the returns (see calculateVolatility): their population
 * standard deviation, 0 for returns all equal.
 *
 * @param params - The returns, the annualized profit, the risk-free return and the elapsed years (see RatioParams)
 * @returns Annualized Sharpe ratio, or 0 when there is no return, no elapsed time or no volatility
 */
export const calculateSharpeRatio = (params: RatioParams): number => calculateAnnualizedRatio(calculateVolatility(params.returns), params);

/**
 * Calculates the annualized Sortino ratio (see calculateAnnualizedRatio).
 * Sortino ratio measures risk-adjusted return using only the downside deviation of the returns (see calculateDownsideDeviation):
 * the root mean square of the losses over all the returns, gains counting as zero, so that only losses are penalised. Not the spread
 * of the losses around their own mean: that is 0 for one loss or equal losses, and ignores how large they are.
 *
 * @param params - The returns, the annualized profit, the risk-free return and the elapsed years (see RatioParams)
 * @returns Annualized Sortino ratio, or 0 when there is no return, no elapsed time or no losing return
 * (without downside risk the ratio is undefined, and 0 is reported instead)
 */
export const calculateSortinoRatio = (params: RatioParams): number =>
  calculateAnnualizedRatio(calculateDownsideDeviation(params.returns), params);

/**
 * Calculates the drawdowns of an equity curve, in one walk of its running peak. The start equity is the first peak, dated with the first
 * sample. A sample at the peak, less than a booked unit below it (see BOOKED_CURRENCY_UNIT), or above it ends the drawdown in progress
 * and dates the peak, which a higher sample raises; a sample a booked unit or more below the peak is in drawdown.
 * - maxDrawdownPct: the largest fall from a peak, in % of the peak (above 100 for a negative equity).
 * - longestDrawdownMs: the longest time from a peak to the sample that gets back to it, or to the last sample for a drawdown still in
 *   progress.
 *
 * @param samples - The equity curve, in chronological order
 * @param initialBalance - The start equity, before the first sample
 * @returns Both drawdowns, 0 without a sample or for an initial balance of 0 or less
 */
export const calculateDrawdowns = (samples: EquitySnapshot[], initialBalance: number): Drawdowns => {
  if (!samples.length || initialBalance <= 0) return { maxDrawdownPct: 0, longestDrawdownMs: 0 };

  let peak = initialBalance;
  let peakDate = samples[0].date;
  let inDrawdown = false;
  let longestDrawdownMs = 0;
  // Each drawdown is compared as a binary quotient, cheap on every sample, and only the largest is measured in decimal, from its peak
  // and trough: in binary, (1000 - 999.7) / 1000 was 0.029999999999995454 %, written 0.02 %
  let largest = { peak, trough: peak, drawdown: 0 };
  for (const { date, totalValue } of samples) {
    const belowPeak = peak - totalValue;
    if (belowPeak >= BOOKED_CURRENCY_UNIT) {
      inDrawdown = true;
      const drawdown = belowPeak / peak;
      if (drawdown > largest.drawdown) largest = { peak, trough: totalValue, drawdown };
    } else if (belowPeak < BOOKED_CURRENCY_UNIT) {
      // Not a plain else: a NaN value fails both comparisons, and is passed over. Taken for a peak, it ended the drawdown in progress
      // at its date, and nothing compares below NaN: the next value became the peak, whatever it was
      if (inDrawdown && date - peakDate > longestDrawdownMs) longestDrawdownMs = date - peakDate;
      // Less than a unit below, the sample is at the peak without lowering it: a run of such samples would let it drift down
      if (totalValue > peak) peak = totalValue;
      peakDate = date;
      inDrawdown = false;
    }
  }
  // A drawdown still in progress lasts to the last sample
  const lastDate = samples[samples.length - 1].date;
  if (inDrawdown && lastDate - peakDate > longestDrawdownMs) longestDrawdownMs = lastDate - peakDate;

  return {
    maxDrawdownPct: largest.drawdown > 0 ? toPercent(addPrecise(largest.peak, -largest.trough), largest.peak) : 0,
    longestDrawdownMs,
  };
};
