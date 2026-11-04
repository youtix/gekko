import type { Portfolio } from '@gekko/shared/models/portfolio.types';
import type { Asset, TradingPair } from '@gekko/shared/models/utility.types';
import { z } from 'zod';
import type { eventSubscriberSchema } from '@gekko/schemas/plugins/eventSubscriber.schema';

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

/** A read of the Trader's portfolio as the plugin keeps it for /portfolio, with the time it is dated with */
export type KeptPortfolio = {
  portfolio: Portfolio;
  /** When the Trader read it, as the order event that brought it says, or when the portfolioChange that brought it arrived */
  at: EpochTimeStamp;
  /** What `at` is: the time of the read, or that of the reception of a portfolioChange, which does not say when the Trader read it */
  dated: 'read' | 'received';
};

/** What the answer to /portfolio is written from (see describePortfolioAnswer) */
export type PortfolioAnswerParams = {
  /** The last read of the Trader's portfolio the events brought: undefined until one did */
  kept?: KeptPortfolio;
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
