import { z } from 'zod';
import type { debugRealtimeStrategySchema } from './debugRealtime.schema';

export type DebugRealtimeParams = z.infer<typeof debugRealtimeStrategySchema>;
