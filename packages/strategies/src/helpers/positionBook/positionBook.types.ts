import { StrategyOrder } from '@gekko/shared/models/advice.types';
import { InitParams, OnCandleEventParams, Tools } from '../../strategy.types';

/** A BUY as the book places it: the book sizes it, so it holds its pair, its type, and a price and a stop if any */
export type BuyOrder = Omit<StrategyOrder, 'side' | 'amount' | 'cost' | 'allocation'>;
/** A SELL as the book places it, of all the asset free: its pair, its type, and a price if any */
export type SellOrder = Omit<StrategyOrder, 'side' | 'trailing' | 'amount' | 'cost' | 'allocation'>;
/** What track reads of the params of init: the bucket, whose pairs it tracks, and the log */
export type TrackParams = Pick<InitParams<unknown>, 'candle'> & { tools: Pick<Tools<unknown>, 'log'> };
/**
 * What buy and sell read of the params of the candle hook that calls them: the candle of every pair, whose close a BUY is priced at
 * when the book estimates what the market makes of it (see PositionBook.buy), the portfolio as of the candle, and the tools
 */
export type OrderParams = Pick<OnCandleEventParams<unknown>, 'candle' | 'portfolio'> & {
  tools: Pick<Tools<unknown>, 'createOrder' | 'log' | 'marketData'>;
};
