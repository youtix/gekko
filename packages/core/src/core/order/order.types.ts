import { FeeTakenInAsset } from '@gekko/shared/models/event.types';
import { OrderSide } from '@gekko/shared/models/order.types';
import { Asset } from '@gekko/shared/models/utility.types';

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
  /**
   * Fee rate in % (0.1 for 0.1 %): the fees of its trades over what they cost, each trade's fee its rate of its own cost, one taken in a
   * third asset without a rate (BNB with Binance's discount) 0, so that the cost of the order times this rate is the fees of its trades
   * added up (see createOrderSummary); undefined when no trade with a known rate cost anything
   */
  feePercent?: number;
  /**
   * The asset the fee was taken in: the one that every trade of the order which names the currency of its fee names (see
   * Trade.fee.currency), the asset bought for a BUY at Binance unless the fees are paid in BNB, the currency for its SELL and for every
   * order of the simulator, BNB with the discount; undefined when no trade names one, or when they name several, as the trades of a BUY
   * whose BNB ran out partway do (see feeTakenInAsset)
   */
  feeAsset?: Asset;
  /**
   * What its fees took of the asset of the pair (see FeeTakenInAsset): the fees of the trades that name the asset as the currency of
   * their fee, each its cost as the exchange reports it, else its rate of the amount of its trade, added up in decimal, and their value
   * in currency, each at the price of its trade (see createOrderSummary). Binance takes a BUY's fee so unless the fees are paid in BNB,
   * and the fees of a BUY whose BNB ran out partway in BNB, then in the asset: feeAsset is then undefined, and this the part the asset
   * paid. Undefined when no trade took its fee in the asset, and for a summary the Trader estimated.
   */
  feeTakenInAsset?: FeeTakenInAsset;
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
