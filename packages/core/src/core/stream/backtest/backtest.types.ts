import { TradingPair } from '@gekko/shared/models/utility.types';
import { Interval } from 'date-fns';

/** Candle counts of a batch read during the backtest, when the read finds fewer candles than the date range check did */
export type BatchCandleCount = { expected: number; received: number };

export interface BacktestStreamParams {
  daterange: Interval<EpochTimeStamp, EpochTimeStamp>;
  symbol: TradingPair;
}

export type MultiAssetBacktestStreamParams = {
  pairs: { symbol: TradingPair }[];
  daterange: Interval<EpochTimeStamp, EpochTimeStamp>;
};
