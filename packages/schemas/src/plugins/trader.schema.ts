import { z } from 'zod';

export const traderSchema = z.strictObject({
  name: z.string().optional(),
  /**
   * Emit the portfolio only when it changes significantly. Whatever it holds back, the end of an order carries the portfolio after it,
   * which the strategy and the analyzers take as the latest.
   */
  portfolioUpdates: z
    .strictObject({
      /** Percentage change required to emit (e.g., 1 for 1%) */
      threshold: z.number().min(0),
      /** Value in quote currency below which an asset is ignored (e.g., 1 for $1) */
      dust: z.number().min(0),
    })
    .optional(),
});
