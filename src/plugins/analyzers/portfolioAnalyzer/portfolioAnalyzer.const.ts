import { EMPTY_PERFORMANCE_STATISTICS } from '../analyzer.const';
import { PortfolioReport } from './portfolioAnalyzer.types';

/** Plugin name constant */
export const PLUGIN_NAME = 'PortfolioAnalyzer';

/** Empty trading report for zero-trade scenarios */
export const EMPTY_PORTFOLIO_REPORT: PortfolioReport = {
  id: 'PORTFOLIO PROFIT REPORT',
  ...EMPTY_PERFORMANCE_STATISTICS,
  startPrice: 0,
  endPrice: 0,
  equityCurve: [],
  maxDrawdownPct: 0,
  longestDrawdownMs: 0,
  startEquity: 0,
  endEquity: 0,
  portfolioChangeCount: 0,
  benchmarkAsset: '', // Will be populated dynamically if possible, or empty string on fail
};
