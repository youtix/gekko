import { HistoricalCandleStream } from './historicalCandle/historicalCandle.stream';
import { MultiAssetStream } from './multiAsset.stream';
import { MultiAssetHistoricalStreamParams } from './multiAssetHistorical.types';

/**
 * The exchange history of every pair, as synchronised `CandleBucket`s. It hands the history of each watched pair what it receives
 * from the pipeline: the run's exchange, the range and the tickrate.
 */
export class MultiAssetHistoricalStream extends MultiAssetStream {
  constructor({ pairs, exchange, daterange, tickrate }: MultiAssetHistoricalStreamParams) {
    super(pairs, symbol => new HistoricalCandleStream({ exchange, daterange, tickrate, symbol }));
  }
}
