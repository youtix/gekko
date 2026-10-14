import { z } from 'zod';
import type { tmaStrategySchema } from './tma.schema';

export type TMAStrategyParams = z.infer<typeof tmaStrategySchema>;
