import { TradingPair } from '@gekko/shared/models/utility.types';
import { HistoricalCandleStreamParams } from './historicalCandle/historicalCandle.types';

/** What the history of each pair reads (see HistoricalCandleStreamParams), for the watched pairs */
export type MultiAssetHistoricalStreamParams = Omit<HistoricalCandleStreamParams, 'symbol'> & {
  pairs: { symbol: TradingPair }[];
};
