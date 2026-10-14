import { z } from 'zod';
import type { demaStrategySchema } from './dema.schema';

export type DEMAStrategyParams = z.infer<typeof demaStrategySchema>;
