import { ORDER_SIDES, ORDER_TYPES } from '../constants/order.const';

export type OrderState = {
  id: string;
  status: 'open' | 'closed' | 'canceled';
  timestamp: EpochTimeStamp;
  filled?: number;
  remaining?: number;
  price?: number;
};

/** One of ORDER_TYPES, from which it derives: the list the StrategyManager checks an order against cannot drift from the type */
export type OrderType = (typeof ORDER_TYPES)[number];
/** One of ORDER_SIDES, from which it derives: the list the StrategyManager checks an order against cannot drift from the type */
export type OrderSide = (typeof ORDER_SIDES)[number];
