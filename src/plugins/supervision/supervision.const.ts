import { Timeframe } from '@models/configuration.types';

/**
 * The timeframes whose candles each exchange serves through ccxt 4.5.39 (its `timeframes`), paper-binance reading Binance's. ccxt
 * sends any other one as is and the exchange refuses it (a BadRequest from Binance), so the candle check batches those candles from
 * 1-minute ones instead, as it does for every timeframe of an exchange missing here.
 */
export const BINANCE_TIMEFRAMES: Timeframe[] = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '1w', '1M'];
export const NATIVE_TIMEFRAMES: Record<string, Timeframe[]> = {
  binance: BINANCE_TIMEFRAMES,
  'paper-binance': BINANCE_TIMEFRAMES,
  hyperliquid: ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '1w', '1M'],
};

/** The answer to a subscription once processFinalize has started */
export const STOPPING_ANSWER = 'Gekko is stopping: no monitoring can start any more';
