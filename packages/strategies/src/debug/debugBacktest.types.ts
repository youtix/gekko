import { z } from 'zod';
import type { debugBacktestStrategySchema } from '@gekko/schemas/strategies/debug/debugBacktest.schema';

export type DebugBacktestParams = z.infer<typeof debugBacktestStrategySchema>;
