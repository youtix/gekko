import { z } from 'zod';
import type { cciStrategySchema } from '@gekko/schemas/strategies/cci.schema';

export type CCIStrategyParams = z.infer<typeof cciStrategySchema>;

export type CCIDirection = 'overbought' | 'oversold' | 'nodirection';

export interface CCITrend {
  direction: CCIDirection;
  duration: number;
  persisted: boolean;
  adviced: boolean;
}
