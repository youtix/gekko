import { inputSourceSchema } from '@models/schema/inputSource.schema';
import { z } from 'zod';

// Unchecked, a misspelt high threshold (hight) compared the RSI with undefined: the strategy bought once and never sold
export const rsiStrategySchema = z.strictObject({
  // A period of 1 read every unchanged close, the flat candles that fill a gap included, as oversold: the strategy bought on them
  period: z.int().min(2, 'period must be at least 2 (the RSI of a single change is 100 on a rise, and 0 on a fall or an unchanged close)'),
  // The close when left out: the RSI indicator's own default, which a block without src always got
  src: inputSourceSchema.default('close'),
  thresholds: z.strictObject({
    high: z.number(),
    low: z.number(),
    persistence: z.int().nonnegative(),
  }),
});
