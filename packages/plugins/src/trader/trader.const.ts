import { LimitOrder } from '@gekko/core/core/order/limit/limitOrder';
import { MarketOrder } from '@gekko/core/core/order/market/marketOrder';
import { StickyOrder } from '@gekko/core/core/order/sticky/stickyOrder';

export const ORDER_FACTORY = {
  MARKET: MarketOrder,
  STICKY: StickyOrder,
  LIMIT: LimitOrder,
} as const;
