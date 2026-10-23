import { Undefined } from '@gekko/shared/models/utility.types';
import { ExchangeDataLimits } from '@gekko/shared/models/exchange.types';

export const BROKER_MAX_RETRIES_ON_FAILURE = 3;

/** Pages of LIMITS[exchange].trades trades CCXTExchange.fetchMyTrades fetches at most, following the trades from the date asked for */
export const MAX_MY_TRADES_PAGES = 20;

export const DUMMY_DEFAULT_BUFFER_SIZE = Number.MAX_SAFE_INTEGER;

/** Candles the dummy exchange keeps per pair, also its fetchOHLCV default limit: the largest real exchange limit (hyperliquid) */
export const DUMMY_CANDLE_BUFFER_SIZE = 5000;

/** Candles the dummy buffer may hold beyond its size before its oldest ones are dropped in one block, rather than one per minute */
export const DUMMY_CANDLE_BUFFER_TRIM_MARGIN = 1000;

export const PARAMS: Record<string, Record<string, Undefined<object>>> = {
  fetchTicker: { hyperliquid: { type: 'spot' } },
  fetchBalance: { hyperliquid: { type: 'spot' } },
};

/**
 * The significant digits a price has at most on the exchanges whose tick depends on the price, which getMarketData states as
 * precision.priceSignificantDigits. ccxt 4.5.39 rounds the price of every Hyperliquid order (priceToPrecision, in createOrder) as
 * Hyperliquid takes it: to 5 significant digits, all the digits of a longer integer part, then to at most 8 decimals less those of the
 * amount on spot, half up both times. It sets precision.price once, when the markets load, to the tick at the mid price of that moment.
 */
export const PRICE_SIGNIFICANT_DIGITS: Record<string, Undefined<number>> = { hyperliquid: 5 };

export const LIMITS: Record<string, ExchangeDataLimits> = {
  binance: { candles: 1000, trades: 1000, orders: 1000 },
  // trades: the most fills Hyperliquid answers at once (userFills, userFillsByTime; ccxt's features.fetchMyTrades.limit). ccxt does not
  // send the limit: CCXTExchange.fetchMyTrades takes a page of that size for a full one, followed by the next
  hyperliquid: { candles: 5000, trades: 2000, orders: 5000 },
  'dummy-cex': {
    candles: DUMMY_CANDLE_BUFFER_SIZE,
    trades: DUMMY_DEFAULT_BUFFER_SIZE,
    orders: DUMMY_DEFAULT_BUFFER_SIZE,
  },
  'paper-binance': { candles: 1000, trades: 1000, orders: 1000 },
};
export const BROKER_MANDATORY_FEATURES = [
  'cancelOrder',
  'createLimitOrder',
  'createMarketOrder',
  'fetchBalance',
  'fetchMyTrades',
  'fetchOHLCV',
  'fetchOpenOrders',
  'fetchOrder',
  'fetchTicker',
  'fetchTickers',
];
