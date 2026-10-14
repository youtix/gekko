/**
 * @fileoverview Financial and statistical utility functions for trading analysis.
 * All functions are pure and stateless. Five throw an Error on an input they cannot measure: calculateElapsedYears on a period that
 * ends before it starts, and calculateTotalReturnPct, calculateAnnualizedReturnPct, calculateMarketReturnPct and calculateExposurePct
 * on a start equity, a number of years, a start price or a period of 0 or less. The others return 0, null or an empty array for an
 * input without anything to measure, or skip such an input.
 *
 * The percentages a report shows (the total, annualized and market returns, the alpha, the max drawdown, the exposure, the win rate)
 * are worked out in decimal (see toPercent): the reporters round them to 2 decimals, most of them down, and wrote 0 % for the 0.01 % a
 * binary quotient made 0.009999999999998899.
 */

import { EquitySnapshot } from '@models/event.types';
import { addPrecise, compareWithTolerance, stdev, toSignificantDigits } from '@utils/math/math.utils';
import { shiftDecimalPoint } from '@utils/math/round.utils';

// ============================================================================
// TYPES
// ============================================================================

/** Input for downside deviation calculation */
export interface DownsideDeviationInput {
  profits: number[];
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
 * Calculates annualized return percentage.
 *
 * @param totalReturnPct - Total return as percentage
 * @param elapsedYears - Time period in years
 * @returns Annualized return percentage
 * @throws Error if elapsedYears is zero or negative
 */
export const calculateAnnualizedReturnPct = (totalReturnPct: number, elapsedYears: number): number => {
  if (elapsedYears <= 0) throw new Error('elapsedYears must be greater than zero');
  // 0.3 % over 3 years is 0.1 % a year, 0.09999999999999999 in binary
  return toSignificantDigits(totalReturnPct / elapsedYears);
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
 * Calculates the returns for each period based on equity snapshots.
 *
 * @param snapshots - Array of equity snapshots
 * @returns Array of percentage returns
 */
export const calculateReturns = (snapshots: EquitySnapshot[]): number[] => {
  const returns: number[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1].totalValue;
    const curr = snapshots[i].totalValue;
    if (prev > 0) returns.push(((curr - prev) / prev) * 100);
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

export interface RatioParams {
  returns: number[];
  yearlyProfit: number;
  riskFreeReturn: number;
  elapsedYears: number;
}

/**
 * Calculates the annualized Sharpe ratio.
 * Sharpe ratio measures risk-adjusted return using standard deviation of all returns.
 *
 * @param params.returns - Array of percentage returns per trade/period
 * @param params.yearlyProfit - Annualized profit percentage
 * @param params.riskFreeReturn - Risk-free rate of return (e.g., 1 for 1%)
 * @param params.elapsedYears - Total elapsed time in years
 * @returns Annualized Sharpe ratio
 */
export const calculateSharpeRatio = ({ returns, yearlyProfit, riskFreeReturn, elapsedYears }: RatioParams): number => {
  if (!returns.length || elapsedYears <= 0) return 0;

  const volatility = stdev(returns);
  const standardDeviation = Number.isNaN(volatility) ? 0 : volatility;

  // Annualize volatility: multiply by sqrt(observations per year)
  const observationsPerYear = returns.length / elapsedYears;
  const annualizedStdDev = standardDeviation * Math.sqrt(observationsPerYear);

  return !annualizedStdDev ? 0 : (yearlyProfit - riskFreeReturn) / annualizedStdDev;
};

/**
 * Calculates the annualized Sortino ratio.
 * Sortino ratio measures risk-adjusted return using only the downside deviation of the returns (see calculateDownsideDeviation):
 * the root mean square of the losses over all the returns, gains counting as zero, so that only losses are penalised.
 * It is annualized like the standard deviation of the Sharpe ratio, by sqrt(observations per year).
 *
 * @param params.returns - Array of percentage returns per trade/period
 * @param params.yearlyProfit - Annualized profit percentage
 * @param params.riskFreeReturn - Risk-free rate of return (e.g., 1 for 1%)
 * @param params.elapsedYears - Total elapsed time in years
 * @returns Annualized Sortino ratio, or 0 when there is no return, no elapsed time or no losing return
 * (without downside risk the ratio is undefined, and 0 is reported instead)
 */
export const calculateSortinoRatio = ({ returns, yearlyProfit, riskFreeReturn, elapsedYears }: RatioParams): number => {
  if (!returns.length || elapsedYears <= 0) return 0;

  // Not the spread of the losses around their own mean: that is 0 for one loss or equal losses, and ignores how large they are
  const downsideDeviation = calculateDownsideDeviation(returns);

  // Annualize downside deviation: multiply by sqrt(observations per year)
  const observationsPerYear = returns.length / elapsedYears;
  const annualizedDownsideDev = downsideDeviation * Math.sqrt(observationsPerYear);

  return !annualizedDownsideDev ? 0 : (yearlyProfit - riskFreeReturn) / annualizedDownsideDev;
};

/**
 * Calculates the maximum drawdown (MDD) as a percentage.
 * Maximum drawdown measures the largest peak-to-trough decline in portfolio value
 * before a new peak is reached.
 *
 * @param balances - Array of balance values in chronological order
 * @param initialBalance - The starting balance before the first sample
 * @returns Maximum drawdown as a positive percentage (0-100)
 */
export const calculateMaxDrawdown = (balances: number[], initialBalance: number): number => {
  if (!balances.length || initialBalance <= 0) return 0;

  // Each drawdown is compared as a binary quotient, cheap on every sample, and only the largest is measured in decimal, from its peak
  // and trough: in binary, (1000 - 999.7) / 1000 was 0.029999999999995454 %, written 0.02 %
  let peak = initialBalance;
  let largest = { peak, trough: peak, drawdown: 0 };
  for (const balance of balances) {
    if (balance > peak) peak = balance;
    const drawdown = (peak - balance) / peak;
    if (drawdown > largest.drawdown) largest = { peak, trough: balance, drawdown };
  }

  return largest.drawdown > 0 ? toPercent(addPrecise(largest.peak, -largest.trough), largest.peak) : 0;
};

/**
 * Calculates the longest drawdown duration in milliseconds.
 * This is the longest time it takes for the portfolio to recover from a peak.
 *
 * @param samples - Array of EquitySnapshot samples in chronological order
 * @param initialBalance - The starting balance
 * @returns Longest drawdown duration in milliseconds
 */
export const calculateLongestDrawdownDuration = (samples: EquitySnapshot[], initialBalance: number): number => {
  if (!samples.length || initialBalance <= 0) return 0;

  let peak = initialBalance;
  let peakDate = samples[0]?.date ?? 0;
  let longestDuration = 0;
  let wasInDrawdown = false;

  for (const { date, totalValue } of samples) {
    if (totalValue < peak) {
      // We're in a drawdown
      wasInDrawdown = true;
    } else if (totalValue >= peak) {
      // New peak or recovery - calculate duration only if we were in a drawdown
      if (wasInDrawdown) {
        const duration = date - peakDate;
        if (duration > longestDuration) longestDuration = duration;
      }
      peak = totalValue;
      peakDate = date;
      wasInDrawdown = false;
    }
  }

  // Check if we're still in a drawdown at the end
  const lastSample = samples.at(-1);
  if (lastSample && wasInDrawdown) {
    const duration = lastSample.date - peakDate;
    if (duration > longestDuration) longestDuration = duration;
  }

  return longestDuration;
};
