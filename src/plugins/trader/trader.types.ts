import { OrderCanceledEvent, OrderInitiatedEvent } from '@models/event.types';
import { OrderType } from '@models/order.types';
import { TradingPair } from '@models/utility.types';
import { Order as AbstractOrder } from '@services/core/order/order';
import { OrderSummary } from '@services/core/order/order.types';
import { UUID } from 'node:crypto';
import { z } from 'zod';
import type { traderSchema } from './trader.schema';

export type Trader = z.infer<typeof traderSchema>;

export type TraderOrderMetadata = {
  /** Order instance */
  orderInstance: AbstractOrder;
  /**
   * The order as initiated, the one its ORDER_INITIATED_EVENT carried: the order the strategy asked for, with the amount the Trader
   * placed it for, the price the strategy asked for, if any, and the cost or the allocation it sized the order by, as it gave them. The
   * events of its end relay it, in both flows (see Trader.onStrategyCancelOrder), each with what it adds. Kept whole: the cancelation
   * flow rebuilt it from copies of its fields, one by one, and a copy that lost one, the amount, passed every test of the Trader.
   */
  order: RelayedOrder;
  /**
   * The price the order was created with, in currency: the price the strategy asked for, else the market price at its creation. A
   * LIMIT order is placed at it. A MARKET order ignores it, executed at the market, and so does a STICKY order, placed from the
   * ticker: at bid + price.min for a BUY, ask - price.min for a SELL. Not the price of `order`, the one the strategy asked for, if any.
   */
  price: number;
  /**
   * The count of synchronizations started when the order was placed: one started after it reads a balance that shows it, reserved or
   * filled (see Trader.unreadOrders and Trader.readHeldByOpenBuys)
   */
  synchronizationCount: number;
  /**
   * The count of synchronizations started when the strategy canceled the order, if it did: one started after it reads a balance from
   * which the exchange has released what the order reserved, the cancelation reaching it first (see Trader.readHeldByOpenBuys)
   */
  cancelSynchronizationCount?: number;
  /**
   * The count of synchronizations started when its completion was heard, if it was: one started after it reads a balance that shows the
   * fill (see Trader.readHeldByOpenBuys). The order stays listed while its report reads the balance and summarizes it.
   */
  endSynchronizationCount?: number;
};

export type CheckOrderSummaryParams = {
  id: UUID;
  symbol: TradingPair;
  type: OrderType;
  orderCreationDate: EpochTimeStamp;
  summary: OrderSummary;
};

export type OrderInstance = TraderOrderMetadata['orderInstance'];
/** An order, as the events relayed to the strategy describe it */
export type RelayedOrder = OrderInitiatedEvent['order'];
/** What an order reports with ORDER_INVALID_EVENT (see Order.orderRejected): `filled` says whether it executed part of its amount */
export type OrderRejection = { reason: string; status: string; filled: boolean };
/** What an order reports with ORDER_CANCELED_EVENT (see Order.orderCanceled): relayed as is */
export type OrderCancelation = { timestamp: EpochTimeStamp } & Pick<OrderCanceledEvent['order'], 'filled' | 'remaining'>;
/**
 * An order the balance read last may not show (see Trader.unreadOrders): what it takes from the free balance of `assetName`, the asset
 * of a SELL, the currency of a BUY
 */
export type UnreadOrder = { assetName: string; amount: number; synchronizationCount: number };
/** The free balance of an asset a SELL can take, or of the currency a BUY can spend (see Trader.getFreeBalanceLeft) */
export type FreeBalanceLeft = {
  /** What the last synchronization read */
  read: number;
  /** What the orders placed since take from it: the SELLs of the asset, the BUYs of the currency */
  taken: number;
  /** What is left of it, never below 0 */
  free: number;
};
/**
 * What an order sized by its cost or by its allocation asks for, before any cap (see Trader.getBudget): the currency a BUY may spend, or
 * the amount of the asset a SELL sells, and `label`, the order and its sizing as the logs name them
 */
export type Budget = { asked: number; label: string };
