import { ORDER_SIDES } from '@constants/order.const';
import { symbolSchema } from '@models/schema/pairConfig.schema';
import { z } from 'zod';

// Candles are counted from 0, the first candle after the warmup, as the other debug strategies count them: a candle below 0, or with a
// fraction, never matches one and its step is never played
const stepSchema = z.strictObject({
  /** The candle the step is played on */
  candle: z.number().int().nonnegative(),
  /** A BUY of each pair of the step, sized by the position book, or an all-in SELL of each */
  side: z.enum(ORDER_SIDES),
  // Written as the configuration writes a symbol, in upper case around one slash: a pair spelt otherwise is no watched pair, which init
  // would refuse then, naming the pairs watched
  /** The pairs the step trades, in this order; left out, every watched pair, in the order of watch.assets */
  symbols: z.array(symbolSchema).min(1).optional(),
});

export const debugPositionBookStrategySchema = z.strictObject({
  /** The steps, those of a candle played in this order */
  steps: z.array(stepSchema).min(1),
});
