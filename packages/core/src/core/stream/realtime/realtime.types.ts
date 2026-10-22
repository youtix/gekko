import { Exchange } from '@gekko/shared/models/exchange.types';
import { TradingPair } from '@gekko/shared/models/utility.types';

export type RealtimeStreamParams = {
  /** The run's exchange (`context.services.exchange()`), which the candles are fetched from */
  exchange: Exchange;
  symbol: TradingPair;
  /** The first minute pushed: the minute in progress when the pipeline read the clock, the warmup history ending with the one before */
  startMinute: EpochTimeStamp;
};
