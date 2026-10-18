import { TradingPair } from '@models/utility.types';
import { Interval } from 'date-fns';

export interface HistoricalCandleStreamParams {
  daterange: Interval<EpochTimeStamp, EpochTimeStamp>;
  /** Minimum delay in ms between the starts of two requests to the exchange */
  tickrate: number;
  symbol: TradingPair;
}
