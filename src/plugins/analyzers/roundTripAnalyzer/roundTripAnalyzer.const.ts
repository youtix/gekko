import { EMPTY_PERFORMANCE_STATISTICS } from '../analyzer.const';
import { TradingReport } from './roundTrip.types';

/** Plugin name constant to avoid minification issues with class.name */
export const PLUGIN_NAME = 'RoundTripAnalyzer';

/** Empty trading report for zero-trade scenarios */
export const EMPTY_TRADING_REPORT: TradingReport = {
  id: 'TRADING REPORT',
  ...EMPTY_PERFORMANCE_STATISTICS,
  startPrice: 0,
  endPrice: 0,
  startBalance: 0,
  finalBalance: 0,
  winRate: null,
  topMAEs: [],
  tradeCount: 0,
};
