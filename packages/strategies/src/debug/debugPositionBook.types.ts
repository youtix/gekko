import { z } from 'zod';
import type { debugPositionBookStrategySchema } from '@gekko/schemas/strategies/debug/debugPositionBook.schema';

export type DebugPositionBookParams = z.infer<typeof debugPositionBookStrategySchema>;
