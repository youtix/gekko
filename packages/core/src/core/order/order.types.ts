import { OrderSide } from '@gekko/shared/models/order.types';

export type OrderStatus =
  | 'canceled' // Order was succesfully canceled
  | 'error'
  | 'filled' // Order is completely filled
  | 'initializing' // Not created
  | 'open' // Order is open on the exchange
  | 'rejected'; // Order was rejected by the exchange

export type Transaction = {
  id: string;
  timestamp: EpochTimeStamp;
  /** The cumulative fill the exchange reported for it, the largest seen; undefined while no state reported one (see recordOrderUpdate) */
  filled?: number;
  /** The price the exchange last reported for it, a limit order's own; undefined while no state reported one above 0 */
  price?: number;
  status: 'open' | 'canceled' | 'closed';
};
export type OrderSummary = {
  amount: number;
  price: number;
  side: OrderSide;
  /** Fee rate in % (0.1 for 0.1 %), weighted by the amounts of the trades whose rate is known; undefined when none is */
  feePercent?: number;
  orderExecutionDate: EpochTimeStamp;
};
export type OrderCancelDetails = {
  timestamp: EpochTimeStamp;
  filled?: number;
  remaining?: number;
  price?: number;
};
export type OrderCancelEventPayload = {
  status: OrderStatus;
} & OrderCancelDetails;
/** What an order reports with ORDER_ERRORED_EVENT (see Order.orderErrored) */
export type OrderErrorEventPayload = {
  reason: string;
  /** Whether the order may still be live on the exchange, where nothing follows it once it errored (see Order.orderErrored) */
  mayBeLive: boolean;
};
