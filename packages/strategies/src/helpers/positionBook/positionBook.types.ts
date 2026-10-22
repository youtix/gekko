import { StrategyOrder } from '@gekko/shared/models/advice.types';
import { BalanceDetail } from '@gekko/shared/models/portfolio.types';
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
/** The balance of the currency in a portfolio the Trader read, as far as it tells one read from another (see isSameRead) */
export type CurrencyRead = Pick<BalanceDetail, 'free' | 'used'>;
/**
 * What a BUY of a book of several pairs is estimated from (see PositionBook.isSkipped): its currency, the balance of it in the
 * portfolio of the hook, what the Trader adds back to the free currency for its own BUYs open at that read (`held`, 0 for an all-in
 * BUY, see PositionBook.getHeldByOpenBuys), and the budget the Trader sizes the BUY from
 */
export type BuyEstimate = { currency: string; read: CurrencyRead; held: number; budget: number };
/**
 * A BUY of the book's own whose outcome has not come yet: what the Trader holds of the currency for it at the reads that show it (its
 * budget less the share kept back for the fee, see PositionBook.buy), and the read of the currency it was sized from, which shows
 * nothing of it
 */
export type PendingBuy = { held: number; sizedFrom: CurrencyRead };
