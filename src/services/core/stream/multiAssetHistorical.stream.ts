import { HistoricalCandleStream } from './historicalCandle/historicalCandle.stream';
import { MultiAssetStream } from './multiAsset.stream';
import { MultiAssetHistoricalStreamParams } from './multiAssetHistorical.types';

/** The exchange history of every pair, as synchronised `CandleBucket`s */
export class MultiAssetHistoricalStream extends MultiAssetStream {
  constructor({ pairs, daterange, tickrate }: MultiAssetHistoricalStreamParams) {
    super(pairs, symbol => new HistoricalCandleStream({ daterange, tickrate, symbol }));
  }
}
