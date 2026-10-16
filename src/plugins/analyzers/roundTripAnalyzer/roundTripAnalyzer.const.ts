import { EMPTY_PERFORMANCE_STATISTICS } from '../analyzer.const';
import { TradingReport } from './roundTrip.types';

/** Plugin name constant to avoid minification issues with class.name */
export const PLUGIN_NAME = 'RoundTripAnalyzer';

/**
 * How many minutes after its date a fill can be heard and still have the adverse excursion of its round trip read from the candles the
 * position held (see countCandle): the one-minute candles kept for a BUY heard late, and the deepenings of the excursion kept for a
 * SELL heard late. In realtime the end of an order reaches the analyzers once the Trader has reported it, after a poll of the order
 * (every orderSynchInterval, 20 s by default) and a read of the portfolio, with the first bucket flushed then: a minute or two after
 * the fill. An hour leaves room for a longer poll, and for an exchange out of reach for most of it.
 */
export const LATE_FILL_CANDLES = 60;

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
