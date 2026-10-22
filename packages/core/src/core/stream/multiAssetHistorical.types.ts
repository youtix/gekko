import { TradingPair } from '@gekko/shared/models/utility.types';
import { Interval } from 'date-fns';

export type MultiAssetHistoricalStreamParams = {
  pairs: { symbol: TradingPair }[];
  daterange: Interval<EpochTimeStamp, EpochTimeStamp>;
  tickrate: number;
};
