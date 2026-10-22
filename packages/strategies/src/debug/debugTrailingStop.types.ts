import { z } from 'zod';
import type { debugTrailingStopStrategySchema } from '@gekko/schemas/strategies/debug/debugTrailingStop.schema';

export type DebugTrailingStopParams = z.infer<typeof debugTrailingStopStrategySchema>;
