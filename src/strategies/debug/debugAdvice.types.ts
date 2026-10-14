import { z } from 'zod';
import type { debugAdviceStrategySchema } from './debugAdvice.schema';

export type DebugAdviceParams = z.infer<typeof debugAdviceStrategySchema>;
