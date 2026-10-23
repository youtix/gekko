import { z } from 'zod';
import type { tmaStrategySchema } from '@gekko/schemas/strategies/tma.schema';

export type TMAStrategyParams = z.infer<typeof tmaStrategySchema>;
