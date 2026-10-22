import { GekkoError } from '@errors/gekko.error';
import { Tag } from '@models/tag.types';
import { Asset } from '@models/utility.types';
import { warning } from '@services/logger';
import { formatDurationUTC } from '@utils/date/date.utils';
import {
  calculateAlpha,
  calculateAnnualizedReturnPct,
  calculateDownsideDeviation,
  calculateElapsedYears,
  calculateExposurePct,
  calculateSharpeRatio,
  calculateSortinoRatio,
  calculateTotalReturnPct,
  calculateVolatility,
  RatioParams,
} from '@helpers/finance/stats.helper';
import { addPrecise, toSignificantDigits } from '@utils/math/math.utils';
import { showValue } from '@utils/object/object.utils';
import { listInWords } from '@utils/string/string.utils';
import { differenceInMilliseconds } from 'date-fns';
import { DEFAULT_BENCHMARK_ASSET, MIN_ANNUALIZATION_HORIZON_MS } from './analyzer.const';
import { PerformanceStatistics, PerformanceStatisticsInput } from './analyzer.types';

/**
 * The asset whose price gives the market return of a report: the benchmarkAsset option when the configuration gives one, which must be
 * a watched asset (a GekkoError under the analyzer's tag otherwise, naming the watched assets, so that the run stops as the plugin is
 * built), else DEFAULT_BENCHMARK_ASSET when it is watched, else the first asset of watch.assets. Both analyzers pick theirs so.
 */
export const pickBenchmarkAsset = (assets: Asset[], configured: Asset | undefined, tag: Tag): Asset => {
  if (configured === undefined) return assets.includes(DEFAULT_BENCHMARK_ASSET) ? DEFAULT_BENCHMARK_ASSET : assets[0];
  if (assets.includes(configured)) return configured;
  throw new GekkoError(tag, `benchmarkAsset must be one of the watched assets (${listInWords(assets)}), got ${showValue(configured)}`);
};

/**
 * The statistics both analyzers report, computed the same way from their own period, equities and returns. The annualized return, the
 * annualized net profit and the Sharpe and Sortino ratios are annualized over one horizon: the period, or the day from its start when
 * it is shorter (see MIN_ANNUALIZATION_HORIZON_MS).
 */
export const calculatePerformanceStatistics = (input: PerformanceStatisticsInput, tag: Tag): PerformanceStatistics => {
  const { periodStartAt, periodEndAt, startEquity, endEquity, returns, marketReturnPct, exposureMs, riskFreeReturn } = input;
  const periodMs = differenceInMilliseconds(periodEndAt, periodStartAt);
  // The horizon in years of the calendar, as the period would be: from its start to its end, or to a day later for a shorter period
  const horizonYears = calculateElapsedYears(periodStartAt, Math.max(periodEndAt, periodStartAt + MIN_ANNUALIZATION_HORIZON_MS));
  if (periodMs < MIN_ANNUALIZATION_HORIZON_MS) {
    warning(
      tag,
      'Period shorter than a day: its annualized return and net profit, and its Sharpe and Sortino ratios, are computed over a day.',
    );
  }

  // In decimal, as the equities are valued: in binary, a period from 1000 to 1000.3 made a net profit of 0.2999999999999545
  const netProfit = addPrecise(endEquity, -startEquity);
  const totalReturnPct = calculateTotalReturnPct(endEquity, startEquity);
  // From the equities, not from totalReturnPct: rounded to 15 significant digits, a gain of 40 on 300,000 over a day made 4.87999999999999
  const annualizedReturnPct = calculateAnnualizedReturnPct(endEquity, startEquity, horizonYears);
  const ratioParams: RatioParams = { returns, yearlyProfit: annualizedReturnPct, riskFreeReturn, elapsedYears: horizonYears };
  // The deviation the Sharpe ratio weighs: 0 for returns all equal, where their standard deviation was the noise of their mean
  const volatility = calculateVolatility(returns);

  return {
    periodStartAt,
    periodEndAt,
    // Counted on the UTC calendar, the same on every machine: on the machine's, a period across a change of daylight saving time came
    // out an hour off, 2024-10-01 to 2024-11-01 reading "30 days 23 hours" in Paris (see formatDurationUTC)
    formattedDuration: formatDurationUTC(periodStartAt, periodEndAt),
    netProfit,
    // A quotient, rid of the noise of the division: 0.3 over 3 years is 0.1 a year, 0.09999999999999999 in binary
    annualizedNetProfit: toSignificantDigits(netProfit / horizonYears),
    totalReturnPct,
    annualizedReturnPct,
    marketReturnPct,
    alpha: calculateAlpha(totalReturnPct, marketReturnPct),
    // A run that ends with the bucket that completed the warmup has a period of 0 ms, and nothing exposed in it
    exposurePct: periodMs > 0 ? calculateExposurePct(exposureMs, periodMs) : 0,
    // A return that is not a number gives a deviation that is not one either: no volatility could be measured
    volatility: Number.isNaN(volatility) ? 0 : volatility,
    downsideDeviation: calculateDownsideDeviation(returns),
    sharpeRatio: calculateSharpeRatio(ratioParams),
    sortinoRatio: calculateSortinoRatio(ratioParams),
  };
};
