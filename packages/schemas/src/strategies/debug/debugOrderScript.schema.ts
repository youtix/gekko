import { ORDER_SIDES, ORDER_TYPES } from '@gekko/shared/constants/order.const';
import { z } from 'zod';

// Candles are counted from 0, the first candle after the warmup, as the other debug strategies count them
const scriptedOrderSchema = z.strictObject({
  /** The candle the order is created on */
  candle: z.number().int().nonnegative(),
  side: z.enum(ORDER_SIDES),
  type: z.enum(ORDER_TYPES),
  /** The amount of the asset; left out, 1, as the other debug strategies order */
  amount: z.number().positive().default(1),
  /** The price the strategy asks for; left out, the last price of the pair (see Tools.createOrder) */
  price: z.number().positive().optional(),
  /** Candles after the one it is created on that the order is canceled on, unless it has ended by then: 1 cancels it on the next one */
  cancelAfter: z.number().int().positive().optional(),
});

export const debugOrderScriptStrategySchema = z.strictObject({
  /** The orders, those of a candle created in this order */
  orders: z.array(scriptedOrderSchema).min(1),
});
