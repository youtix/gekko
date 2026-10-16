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
