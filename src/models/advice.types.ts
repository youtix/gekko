import { UUID } from 'node:crypto';
import { OrderSide, OrderType } from './order.types';
import { TradingPair } from './utility.types';

export type TrailingConfig = {
  /** The percent to trail away from the highest peak, above 0 and below 100 (e.g., 2.5 for 2.5%): createOrder refuses anything else */
  percentage: number;
  /** The price that activates the trailing monitoring, above 0; leave it out for a stop active as soon as it is armed */
  trigger?: number;
};

export type AdviceOrder = {
  /** A watched pair: createOrder refuses any other */
  symbol: TradingPair;
  /** Gekko order id */
  id: UUID;
  /** Order creation date */
  orderCreationDate: EpochTimeStamp;
  /** Order side */
  side: OrderSide;
  /** Order type */
  type: OrderType;
  /**
   * The amount of the asset to trade, above 0. Left out with `cost` and `allocation`, the order is all-in: the Trader sizes it from the
   * free balance it read last (see Tools.createOrder).
   */
  amount?: number;
  /**
   * The currency to trade, in place of an amount: above 0, in the currency of the pair (the USDT of BTC/USDT), turned into an amount
   * at the price of the order, else the last price of the pair. A BUY spends at most that, the 5 % the Trader keeps back for the fee
   * included (DEFAULT_FEE_BUFFER): it buys cost × 0.95 / price, and a cost of all the currency free is an all-in BUY. A SELL sells
   * cost / price, its fee taken from what it brings in. createOrder refuses it beside an amount or an allocation (see
   * Tools.createOrder).
   */
  cost?: number;
  /**
   * A share of a balance, in place of an amount: in percent, above 0 and at most 100 (25 for 25 %), of the currency free for a BUY, of
   * the asset free for a SELL, as the Trader's last synchronization read it. Of that balance, not of what the orders placed since leave
   * of it: two BUYs of 50 % on one candle are both sized from the whole, and a BUY of 100 % is an all-in BUY. createOrder refuses it
   * beside an amount or a cost (see Tools.createOrder).
   */
  allocation?: number;
  /** Order price */
  price?: number;
};

/**
 * A cancellation the strategy asked for (STRATEGY_CANCEL_ORDER_EVENT, Tools.cancelOrder): the id of the order, and its pair when the
 * StrategyManager knows the order, one it created in this run whose outcome it has not heard of yet. Left out otherwise: the Trader,
 * which has forgotten such an order or never had it, then warns of an unknown order, and the EventSubscriber's strat_cancel
 * notification says so.
 */
export type AdviceCancelOrder = {
  /** Gekko order id, as createOrder returned it */
  id: UUID;
  /** The pair of the order, when known */
  symbol?: TradingPair;
};

export type StrategyOrder = Omit<AdviceOrder, 'id' | 'orderCreationDate'> & {
  /**
   * BUY orders only, holding no key but percentage and trigger (createOrder refuses anything else): a stop armed once the BUY completes,
   * from a copy taken by createOrder. It does not trigger while a SELL the strategy created is pending on its pair (see
   * Tools.createOrder).
   */
  trailing?: TrailingConfig;
};
