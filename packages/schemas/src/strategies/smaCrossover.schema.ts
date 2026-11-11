import { inputSourceSchema } from '../configuration/inputSource.schema';
import { z } from 'zod';

// Unchecked, a period of 0 or 2.5 made the SMA NaN on every candle, and the strategy never traded
export const smaCrossoverStrategySchema = z.strictObject({
  period: z.int().positive(),
  // What the SMA averages, the close when left out: the SMA's own default, which a block without src always got. The price compared
  // with the SMA is the close whatever the source: `src: hl2` has the close cross the SMA of hl2.
  src: inputSourceSchema.default('close'),
});
