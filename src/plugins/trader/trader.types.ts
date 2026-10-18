import { OrderCanceledEvent, OrderInitiatedEvent } from '@models/event.types';
import { OrderSide, OrderType } from '@models/order.types';
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
  /** Order creation date */
  orderCreationDate: EpochTimeStamp;
  /** Order amount */
  amount: number;
  /** Order side (SELL | BUY)*/
  side: OrderSide;
  /** Order type ('MARKET' | 'STICKY' | 'LIMIT')*/
  type: OrderType;
  /**
   * The price the order was created with, in currency: the price the strategy asked for, else the market price at its creation. A
   * LIMIT order is placed at it. A MARKET order ignores it, executed at the market, and so does a STICKY order, placed from the
   * ticker: at bid + price.min for a BUY, ask - price.min for a SELL.
   */
  price: number;
  /** The price the strategy asked for, if any: the price its terminal events relay, in both flows (see Trader.onStrategyCancelOrder) */
  requestedPrice?: number;
  /**
   * The cost the strategy sized the order by, in currency, as it gave it, and left out for an order it sized otherwise: its terminal
   * events relay it in both flows (see Trader.onStrategyCancelOrder)
   */
  cost?: number;
  /** The allocation the strategy sized the order by, in percent, as it gave it, and left out for an order it sized otherwise (see cost) */
  allocation?: number;
  /** Trading Pair */
  symbol: TradingPair;
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
