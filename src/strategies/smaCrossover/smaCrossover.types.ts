import { z } from 'zod';
import type { smaCrossoverStrategySchema } from './smaCrossover.schema';

export type SMACrossoverStrategyParams = z.infer<typeof smaCrossoverStrategySchema>;
