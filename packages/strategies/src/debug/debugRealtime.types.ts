import { z } from 'zod';
import type { debugRealtimeStrategySchema } from '@gekko/schemas/strategies/debug/debugRealtime.schema';

export type DebugRealtimeParams = z.infer<typeof debugRealtimeStrategySchema>;
