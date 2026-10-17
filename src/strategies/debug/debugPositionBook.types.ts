import { z } from 'zod';
import type { debugPositionBookStrategySchema } from './debugPositionBook.schema';

export type DebugPositionBookParams = z.infer<typeof debugPositionBookStrategySchema>;
