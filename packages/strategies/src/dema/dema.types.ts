import { z } from 'zod';
import type { demaStrategySchema } from '@gekko/schemas/strategies/dema.schema';

export type DEMAStrategyParams = z.infer<typeof demaStrategySchema>;

/** The trend of a pair */
export type PairTrend = {
  currentTrend?: 'down' | 'up';
  /**
   * Whether the current trend has placed its order. It waits while the strategy holds the other position on the pair or an order is
   * pending there: a BUY that fills during a downtrend is sold on the next candle of that downtrend.
   */
  isTrendAdviced: boolean;
};
