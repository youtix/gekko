import { EMPTY_PERFORMANCE_STATISTICS } from '../analyzer.const';
import { TradingReport } from './roundTrip.types';

/** Plugin name constant to avoid minification issues with class.name */
export const PLUGIN_NAME = 'RoundTripAnalyzer';

/**
 * The smallest amount of currency the exchanges book, a unit of the 8th decimal: the simulator rounds the currency of each order to it
 * (COST_DECIMALS), and Binance keeps every balance to 8 decimals. A round trip values its position at the price of its fills, amount
 * × price, where the exchange booked that cost rounded to the unit: sold back at its own price without a fee, a round trip that made
 * nothing came out up to half a unit off 0 once amount × price had more decimals (prices to 1e-6 and amounts to 1e-4, as on ETH/BTC),
 * a win or a loss for 95 % of them. Two equities less than a unit apart are one amount.
 */
export const BOOKED_CURRENCY_UNIT = 1e-8;

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
