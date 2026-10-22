import { z } from 'zod';

// each, wait and cancelAfter count timeframe candles: whole numbers, and each above 0, as each 0 never advised (n % 0 is NaN)
export const debugAdviceStrategySchema = z.strictObject({
  /** Advises every `each` candles, a SELL first, then a BUY, and so on: 1 advises on every candle */
  each: z.number().int().positive(),
  /** Candles let go by before the first advice; left out, 0: the first advice comes on the first candle after the warmup */
  wait: z.number().int().nonnegative().default(0),
  /** Candles after which an order the strategy created is canceled (0 cancels on the next candle, as 1 does); left out, never */
  cancelAfter: z.number().int().nonnegative().optional(),
});
