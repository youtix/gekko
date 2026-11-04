import { z } from 'zod';
import type { rsiStrategySchema } from '@gekko/schemas/strategies/rsi.schema';

export type RSICurrentTrend = {
  duration: number;
  direction: 'high' | 'low' | 'none';
  adviced: boolean;
};

export type RSIStrategyParams = z.infer<typeof rsiStrategySchema>;
