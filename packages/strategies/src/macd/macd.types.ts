import { z } from 'zod';
import type { macdStrategySchema } from '@gekko/schemas/strategies/macd.schema';

export type MACDStrategyParams = z.infer<typeof macdStrategySchema>;

export type MACDTrend = { duration: number; persisted: boolean; direction: 'up' | 'down' | 'none'; adviced: boolean };
