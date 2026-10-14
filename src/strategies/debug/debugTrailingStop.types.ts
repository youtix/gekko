import { z } from 'zod';
import type { debugTrailingStopStrategySchema } from './debugTrailingStop.schema';

export type DebugTrailingStopParams = z.infer<typeof debugTrailingStopStrategySchema>;
