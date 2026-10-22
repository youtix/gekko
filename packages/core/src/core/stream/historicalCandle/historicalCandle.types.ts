import { Exchange } from '@gekko/shared/models/exchange.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { Interval } from 'date-fns';

export interface HistoricalCandleStreamParams {
  /** The run's exchange (`context.services.exchange()`), which the candles are fetched from */
  exchange: Exchange;
  daterange: Interval<EpochTimeStamp, EpochTimeStamp>;
  /** Minimum delay in ms between the starts of two requests to the exchange */
  tickrate: number;
  symbol: TradingPair;
}
