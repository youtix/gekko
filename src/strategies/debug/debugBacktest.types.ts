import { z } from 'zod';
import type { debugBacktestStrategySchema } from './debugBacktest.schema';

export type DebugBacktestParams = z.infer<typeof debugBacktestStrategySchema>;
