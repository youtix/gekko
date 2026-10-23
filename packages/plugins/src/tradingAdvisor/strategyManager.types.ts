import { TradingPair } from '@gekko/shared/models/utility.types';

/** What the StrategyManager keeps of an order it created, until it hears of its outcome (see StrategyManager.pendingOrders) */
export type OrderRecord = {
  /** The pair of the order, which a cancellation the strategy asks for names (see StrategyManager.cancelOrder) */
  symbol: TradingPair;
  /**
   * Who sells, for a SELL: the strategy, whose SELL holds back the triggers of the stops of its pair until its outcome (see
   * StrategyManager.isTriggerHeld), or a trailing stop, whose SELL settles that stop alone (see StrategyManager.onOrderCompleted).
   * Left out for a BUY.
   */
  seller?: 'strategy' | 'stop';
};
