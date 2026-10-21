import { OrderSide } from '@models/order.types';
import { OnOrderCanceledEventParams, OnOrderErroredEventParams } from '@strategies/strategy.types';

export type UnfinishedOrderParams = OnOrderCanceledEventParams<unknown> | OnOrderErroredEventParams<unknown>;
/** What a cancelation reports its order executed: the amount filled, and what remains of the amount ordered */
export type Fill = { filled: number; remaining: number };
/**
 * An order of the tracker's own whose outcome has not come yet: its side, and the amount a SELL asked for, unknown when all-in, sized
 * by a cost or an allocation, or adopted (see coversAmountAsked)
 */
export type PendingOrder = { side: OrderSide; amount?: number };
