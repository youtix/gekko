import { LimitOrder } from '@services/core/order/limit/limitOrder';
import { MarketOrder } from '@services/core/order/market/marketOrder';
import { StickyOrder } from '@services/core/order/sticky/stickyOrder';

export const ORDER_FACTORY = {
  MARKET: MarketOrder,
  STICKY: StickyOrder,
  LIMIT: LimitOrder,
} as const;
