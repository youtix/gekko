import type { Configuration as ConfigurationModel, Watch } from '@gekko/schemas/configuration/configuration.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { Interval } from 'date-fns';
import type { Storage } from '../../../storage/storage';

/** Candle counts of a batch read during the backtest, when the read finds fewer candles than the date range check did */
export type BatchCandleCount = { expected: number; received: number };

export interface BacktestStreamParams {
  daterange: Interval<EpochTimeStamp, EpochTimeStamp>;
  symbol: TradingPair;
  /** `watch.batchSize`: the minutes read per batch, a day when it is left out */
  batchSize: Watch['batchSize'];
  /** The strategy block, whose name the start-up line gives */
  strategy: ConfigurationModel['strategy'];
  /** The run's storage (`context.services.storage()`), which the candles are read from */
  storage: Storage;
}

/** What the backtest of each pair reads (see BacktestStreamParams), for the watched pairs */
export type MultiAssetBacktestStreamParams = Omit<BacktestStreamParams, 'symbol'> & {
  pairs: { symbol: TradingPair }[];
};
