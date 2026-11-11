import { StrategyOrder } from '@gekko/shared/models/advice.types';
import { MarketData } from '@gekko/shared/models/exchange.types';
import { BalanceDetail, Portfolio } from '@gekko/shared/models/portfolio.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { LoggerFn } from '@gekko/strategies/strategy.types';
import { UUID } from 'node:crypto';

/**
 * What the book reads of the run, given by the StrategyManager as it builds it. Getters, not values: the manager replaces its portfolio
 * and its market data during the run, and the close of a pair moves with each timeframe candle. The book and its trackers read it when
 * they need it, at the call: no strategy hands them anything.
 */
export type PositionBookContext = {
  /**
   * The manager's createOrder (Tools.createOrder): its checks, its id, its record of the order as the strategy's own, so that a SELL of
   * the book holds back the trailing stops of its pair while it pends, and the trailing a BUY of the book asks for is armed once it
   * completes
   */
  createOrder: (order: StrategyOrder) => UUID;
  /**
   * The strategy's log (Tools.log): every line of the book and of its trackers goes through it, as a line of the strategy's own, relayed
   * as strategy info but at debug level
   */
  log: LoggerFn;
  /**
   * The last portfolio the manager received, its own: the candle hooks get a copy of it, to which the strategy may write without
   * changing what the book estimates a BUY from
   */
  getPortfolio: () => Portfolio;
  /** The market data of a pair as the manager's checks read it, undefined for a pair it has none of */
  getMarketData: (pair: TradingPair) => MarketData | undefined;
  /** The close of the last timeframe candle of a pair, undefined before the first one */
  getClose: (pair: TradingPair) => number | undefined;
  /**
   * Whether the trailing stop the BUY `buyId` asked for is still alive: pending until that BUY's outcome arms it, then armed until it is
   * over or canceled (see PositionBook.adoptStopSell)
   */
  isStopAlive: (buyId: UUID) => boolean;
};
/** The balance of the currency in a portfolio the Trader read, as far as it tells one read from another (see isSameRead) */
export type CurrencyRead = Pick<BalanceDetail, 'free' | 'used'>;
/**
 * What a BUY of a book of several pairs is estimated from (see PositionBook.isSkipped): its currency, the balance of it in the portfolio
 * the book reads (see PositionBookContext.getPortfolio), what the Trader adds back to the free currency for its own BUYs open at that
 * read (`held`, 0 for an all-in BUY, see PositionBook.getHeldByOpenBuys), and the budget the Trader sizes the BUY from
 */
export type BuyEstimate = { currency: string; read: CurrencyRead; held: number; budget: number };
/**
 * A BUY of the book's own whose outcome has not come yet: what the Trader holds of the currency for it at the reads that show it (its
 * budget less the share kept back for the fee, see PositionBook.buy), and the read of the currency it was sized from, which shows
 * nothing of it
 */
export type PendingBuy = { held: number; sizedFrom: CurrencyRead };
