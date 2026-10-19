import type { Portfolio } from '@models/portfolio.types';
import type { Asset, TradingPair } from '@models/utility.types';
import { z } from 'zod';
import type { eventSubscriberSchema } from './eventSubscriber.schema';

export const EVENT_NAMES = [
  'strat_info',
  'strat_create',
  'strat_cancel',
  'order_init',
  'order_cancel',
  'order_error',
  'order_complete',
  'roundtrip_complete',
] as const;

export type Event = (typeof EVENT_NAMES)[number];

export type EventSubscriberConfig = z.infer<typeof eventSubscriberSchema>;

/** A message waiting for its turn, with the event it notifies of, which the logs name */
export type PendingNotification = { event: Event; text: string };

/** What the answer to /portfolio is written from (see describePortfolioAnswer) */
export type PortfolioAnswerParams = {
  /** The last portfolio the Trader read, as the plugin received it: undefined until one is */
  portfolio?: Portfolio;
  /** When that portfolio was received */
  portfolioAt?: EpochTimeStamp;
  /** The close of each pair's last 1-minute candle */
  prices: Map<TradingPair, number>;
  /** The close of the last 1-minute bucket processed, which `prices` are the closes of: undefined until one is */
  pricesAt?: EpochTimeStamp;
  /** The watched pairs, in the order of watch.assets: the pair of each of `assets` with the currency */
  pairs: TradingPair[];
  /** The watched assets, in the order of watch.assets */
  assets: Asset[];
  currency: Asset;
  /** When the answer is written: the age of the balances is counted up to it */
  now: EpochTimeStamp;
};
