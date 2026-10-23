import { MultiAssetStream } from '../multiAsset.stream';
import { BacktestStream } from './backtest.stream';
import { MultiAssetBacktestStreamParams } from './backtest.types';

/**
 * The stored candles of every pair, as synchronised `CandleBucket`s. It hands the backtest of each watched pair what it receives from
 * the pipeline: the range, `watch.batchSize` and the run's storage.
 */
export class MultiAssetBacktestStream extends MultiAssetStream {
  constructor({ pairs, daterange, batchSize, storage }: MultiAssetBacktestStreamParams) {
    super(pairs, symbol => new BacktestStream({ daterange, batchSize, storage, symbol }));
  }
}
