import { z } from 'zod';
import type { debugOrderScriptStrategySchema } from './debugOrderScript.schema';

export type DebugOrderScriptParams = z.infer<typeof debugOrderScriptStrategySchema>;
