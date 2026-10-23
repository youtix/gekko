import { OrderSide } from '@gekko/shared/models/order.types';
import { OnOrderCanceledEventParams, OnOrderErroredEventParams } from '../../strategy.types';

export type UnfinishedOrderParams = OnOrderCanceledEventParams<unknown> | OnOrderErroredEventParams<unknown>;
/** How an order of the tracker's own ended without completing */
export type UnfinishedOutcome = 'canceled' | 'errored';
/** What a cancelation reports its order executed: the amount filled, and what remains of the amount ordered */
export type Fill = { filled: number; remaining: number };
/**
 * What an order leaves held of its asset, as read after its end (see getHolding and getUnreadHolding): the amount, with the fact it is
 * taken from, as the tracker's line writes it. `least` marks an amount that is only the least held, the rest of the asset beyond the
 * order unknown: it makes the position long when it is enough to sell, and tells nothing otherwise.
 */
export type Holding = { held: number; fact: string; least?: boolean };
/**
 * An order of the tracker's own whose outcome has not come yet: its side, and the amount a SELL asked for, unknown when all-in, sized
 * by a cost or an allocation, or adopted (see coversAmountAsked)
 */
export type PendingOrder = { side: OrderSide; amount?: number };
