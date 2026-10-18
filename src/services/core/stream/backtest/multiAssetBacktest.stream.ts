import { MultiAssetStream } from '../multiAsset.stream';
import { BacktestStream } from './backtest.stream';
import { MultiAssetBacktestStreamParams } from './backtest.types';

/** The stored candles of every pair, as synchronised `CandleBucket`s */
export class MultiAssetBacktestStream extends MultiAssetStream {
  constructor({ pairs, daterange }: MultiAssetBacktestStreamParams) {
    super(pairs, symbol => new BacktestStream({ daterange, symbol }));
  }
}
