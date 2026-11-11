import { Report } from '@gekko/shared/models/event.types';
import { z } from 'zod';
import type { analyzerSchema } from '@gekko/schemas/plugins/analyzer.schema';

export type AnalyzerConfig = z.infer<typeof analyzerSchema>;

/** What both analyzers measure a period with (see calculatePerformanceStatistics) */
export type PerformanceStatisticsInput = {
  /** The start of the period: the close of the timeframe candle that completed the warmup */
  periodStartAt: EpochTimeStamp;
  /** The end of the period: the end of the last bucket */
  periodEndAt: EpochTimeStamp;
  /** The equity the period starts from, greater than 0 */
  startEquity: number;
  /** The equity the period ends with, marked to market at the last prices */
  endEquity: number;
  /**
   * The returns the volatility and the ratios weigh, in %: one per round trip (RoundTripAnalyzer), one per timeframe candle
   * (PortfolioAnalyzer)
   */
  returns: number[];
  /** The return of the market over the period, in %: buying and holding the asset, or the benchmark asset */
  marketReturnPct: number;
  /** The time of the period spent exposed to the market */
  exposureMs: number;
  /** The yearly return of a riskless investment, in % */
  riskFreeReturn: number;
};

/** The fields of a report that both analyzers compute the same way */
export type PerformanceStatistics = Omit<Report, 'id' | 'startPrice' | 'endPrice' | 'benchmarkAsset'>;
