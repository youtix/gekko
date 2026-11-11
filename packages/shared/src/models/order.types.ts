import { ORDER_SIDES, ORDER_TYPES } from '../constants/order.const';

/**
 * The state of an order as an exchange reports it: in the answer to its creation, to a read (fetchOrder) or to its cancelation, or as
 * the simulated exchange settles it.
 */
export type OrderState = {
  id: string;
  status: 'open' | 'closed' | 'canceled';
  /**
   * The time the exchange dates the order with: its creation in the answer to the creation and in a read (Binance's time, Hyperliquid's
   * timestamp, the clock of the simulated exchange as it placed the order), but in Binance's answer to a cancelation, which gives the time
   * of the cancelation alone (transactTime); when ccxt gives none, its last update, then the time it was read (see mapCcxtOrderToOrder).
   * An order keeps the first one it records, from which its trades are fetched (see Order.recordOrderUpdate).
   */
  timestamp: EpochTimeStamp;
  /**
   * The time of the last change of the order: its cancelation for a canceled one, its last fill or its creation otherwise. ccxt's
   * lastUpdateTimestamp (Binance's transactTime or updateTime, Hyperliquid's statusTimestamp), else the time the state was read; the clock
   * of the simulated exchange at that change. A canceled order is dated with it (see Order.applyOrderUpdate), not with its timestamp,
   * which a read gives as the creation of the order.
   */
  lastUpdateTimestamp: EpochTimeStamp;
  filled?: number;
  remaining?: number;
  price?: number;
};

/** One of ORDER_TYPES, from which it derives: the list the StrategyManager checks an order against cannot drift from the type */
export type OrderType = (typeof ORDER_TYPES)[number];
/** One of ORDER_SIDES, from which it derives: the list the StrategyManager checks an order against cannot drift from the type */
export type OrderSide = (typeof ORDER_SIDES)[number];
