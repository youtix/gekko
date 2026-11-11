import { z } from 'zod';
import type { debugOrderScriptStrategySchema } from '@gekko/schemas/strategies/debug/debugOrderScript.schema';

export type DebugOrderScriptParams = z.infer<typeof debugOrderScriptStrategySchema>;
