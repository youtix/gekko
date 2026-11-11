import { z } from 'zod';

// Unchecked, a misspelt thresholds block (tresholds) threw a TypeError at the first candle with the DEMA ready, hours into a
// realtime run
export const demaStrategySchema = z.strictObject({
  period: z.int().min(2, 'period must be at least 2 (the DEMA and the SMA of a single candle are both its close, so they never differ)'),
  thresholds: z.strictObject({
    up: z.number(),
    down: z.number(),
  }),
});
