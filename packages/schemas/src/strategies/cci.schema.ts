import { z } from 'zod';

// Unchecked, a misspelt persistence (persistance) left it undefined, and the strategy never traded
export const cciStrategySchema = z.strictObject({
  period: z.int().min(2, 'period must be at least 2 (the CCI of a single candle is always 0)'),
  thresholds: z.strictObject({
    up: z.number(),
    down: z.number(),
    persistence: z.int().nonnegative(),
  }),
});
