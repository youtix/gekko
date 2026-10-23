import { inputSourceSchema } from '../configuration/inputSource.schema';
import { z } from 'zod';

// The ribbon parameters are the EMARibbon indicator's input, handed on as they are
export const emaRibbonStrategySchema = z.strictObject({
  /** Source of the EMA ribbon. The close when left out: the indicator's own default, which a block without src always got */
  src: inputSourceSchema.default('close'),
  /** Number of EMAs */
  count: z.int().min(2, 'count must be at least 2 (the spread of a single EMA is always 0)'),
  /** Period of the first, fastest EMA */
  start: z.int().positive(),
  /**
   * Step between the periods of two consecutive EMAs. A fractional step gave fractional periods, whose EMA never seeded, and a step of
   * 0 EMAs of the same period, whose spread is always 0.
   */
  step: z.int().positive(),
  /** Spread, in quote currency, below which a bullish ribbon can buy */
  spreadCompressionThreshold: z.number(),
});
