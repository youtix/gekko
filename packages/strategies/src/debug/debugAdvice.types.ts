import { z } from 'zod';
import type { debugAdviceStrategySchema } from '@gekko/schemas/strategies/debug/debugAdvice.schema';

export type DebugAdviceParams = z.infer<typeof debugAdviceStrategySchema>;
