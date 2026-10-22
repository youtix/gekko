import { ONE_MINUTE } from '@constants/time.const';
import type { RoundTrip } from '@models/event.types';
import type { PercentRounding } from '@utils/string/string.utils';
import { PerformanceStatistics } from './analyzer.types';
import type { PortfolioReport } from './portfolioAnalyzer/portfolioAnalyzer.types';
import type { TradingReport } from './roundTripAnalyzer/roundTrip.types';

/**
 * How each percentage of the reports and of a round trip is rounded to its 2 decimals (see formatPercent), the same wherever it is
 * written: the CSV of the PerformanceReporter (documentation/plugins.md), the console tables of the analyzers and the Telegram message
 * of a round trip. Down for a return, the alpha, a drawdown and an adverse excursion; half to even for a share of the round trips or of
 * the time. Each output rounded in its own way, and one figure read 0.01 apart from one to the other: a total return of -5.001 % was
 * -5.00 % on the console and -5.01 % in the CSV, a win rate of 3.125 % 3.13 % and 3.12 %, a round trip of 2.345 % 2.35 % on Telegram
 * and 2.34 % on the console.
 */
export const PERCENT_ROUNDING = {
  totalReturnPct: 'down',
  annualizedReturnPct: 'down',
  marketReturnPct: 'down',
  alpha: 'down',
  maxDrawdownPct: 'down',
  profit: 'down',
  maxAdverseExcursion: 'down',
  winRate: 'halfEven',
  exposurePct: 'halfEven',
} as const satisfies Partial<Record<keyof PortfolioReport | keyof TradingReport | keyof RoundTrip, PercentRounding>>;

/**
 * The share of a position below which what is left of it is dust that no SELL can sell: an amount rounded down to the lot size of the
 * exchange, a BUY fee taken from the asset bought (as Binance does), both common in realtime. The RoundTripAnalyzer ends a round trip
 * once what is left of its position is at most this share of the amount its BUYs bought; the PortfolioAnalyzer counts an asset as held
 * only while it is worth at least this share of the portfolio (see its holdsAsset).
 */
export const DUST_TOLERANCE = 0.01;

/** The benchmark of a report whose configuration names none, when it is watched; else the first asset of watch.assets (see pickBenchmarkAsset) */
export const DEFAULT_BENCHMARK_ASSET = 'BTC';

/**
 * The shortest horizon the annualized figures extrapolate from: a day. Annualizing multiplies the return of the period by the number
 * of such periods in a year, about 66,000 for a period of 8 minutes: the moves of a few candles would make a yearly return of
 * thousands of %, with Sharpe and Sortino ratios to match. A day holds a whole cycle of crypto markets, which trade around the clock,
 * and caps that factor at 366; a longer horizon would understate the annualized figures of the runs of a few days, common in realtime.
 * A shorter period is annualized as if its returns had been spread over the day from its start: its annualized return, its annualized
 * net profit and its ratios alike, so that they agree with one another (see calculatePerformanceStatistics).
 */
export const MIN_ANNUALIZATION_HORIZON_MS = 24 * 60 * ONE_MINUTE;

/** The statistics of a report without data to measure */
export const EMPTY_PERFORMANCE_STATISTICS: PerformanceStatistics = {
  periodStartAt: 0,
  periodEndAt: 0,
  formattedDuration: '',
  netProfit: 0,
  annualizedNetProfit: 0,
  totalReturnPct: 0,
  annualizedReturnPct: 0,
  marketReturnPct: 0,
  alpha: 0,
  exposurePct: 0,
  volatility: 0,
  downsideDeviation: 0,
  sharpeRatio: 0,
  sortinoRatio: 0,
};
