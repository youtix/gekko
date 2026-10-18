import { DEFAULT_FEE_BUFFER } from '@constants/order.const';
import { LimitOrder } from '@services/core/order/limit/limitOrder';
import { MarketOrder } from '@services/core/order/market/marketOrder';
import { StickyOrder } from '@services/core/order/sticky/stickyOrder';
import { shiftDecimalPoint } from '@utils/math/round.utils';

export const ORDER_FACTORY = {
  MARKET: MarketOrder,
  STICKY: StickyOrder,
  LIMIT: LimitOrder,
} as const;

/**
 * The keys with which a strategy sizes an order otherwise than by its amount: every event of the order relays them as the strategy gave
 * them, left out when it gave none (see OrderEvent)
 */
export const SIZING_KEYS = ['cost', 'allocation'] as const;

/** The share of its currency DEFAULT_FEE_BUFFER keeps back for the fee of a BUY sized from the currency, in %, as the logs write it */
export const FEE_BUFFER_PERCENT = shiftDecimalPoint(DEFAULT_FEE_BUFFER, 2);
