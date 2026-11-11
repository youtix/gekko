import { inputSourceSchema } from '../configuration/inputSource.schema';
import { z } from 'zod';

// Unchecked, a misspelt short (shrt) left the short SMA on the indicator's default period, 30
export const tmaStrategySchema = z
  .strictObject({
    short: z.int().positive(),
    medium: z.int().positive(),
    long: z.int().positive(),
    // The close when left out: the SMAs' own default, which a block without src always got
    src: inputSourceSchema.default('close'),
  })
  // The uptrend is short > medium > long: swapped periods bought on the opposite alignment, and two equal ones never aligned. Zod
  // still runs the refinement after a failed bound: a period below 1, already reported, is not compared.
  .refine(({ short, medium, long }) => Math.min(short, medium, long) < 1 || (short < medium && medium < long), {
    message: 'short, medium and long must increase, short < medium < long (swapped periods give the opposite signal, equal ones none)',
  });
