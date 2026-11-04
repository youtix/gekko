import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { toISOString } from '@gekko/shared/utils/date/date.utils';
import { Interval } from 'date-fns';

export class HistoricalCandleError extends GekkoError {
  constructor(symbol: TradingPair, { start, end }: Interval<EpochTimeStamp, EpochTimeStamp>, attempts: number) {
    super('stream', `The exchange returned no ${symbol} candle from ${toISOString(start)} to ${toISOString(end)} (${attempts} attempts).`);
    this.name = 'HistoricalCandleError';
  }
}
