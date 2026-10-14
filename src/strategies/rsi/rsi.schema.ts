import { inputSourceSchema } from '@models/schema/inputSource.schema';
import { z } from 'zod';

// Unchecked, a misspelt high threshold (hight) compared the RSI with undefined: the strategy bought once and never sold
export const rsiStrategySchema = z.strictObject({
  period: z.int().positive(),
  // The close when left out: the RSI indicator's own default, which a block without src always got
  src: inputSourceSchema.default('close'),
  thresholds: z.strictObject({
    high: z.number(),
    low: z.number(),
    persistence: z.int().nonnegative(),
  }),
});
