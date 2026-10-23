import { z } from 'zod';
import type { macdStrategySchema } from '@gekko/schemas/strategies/macd.schema';

export type MACDStrategyParams = z.infer<typeof macdStrategySchema>;

export type MACDTrend = { duration: number; persisted: boolean; direction: 'up' | 'down' | 'none'; adviced: boolean };

/**
 * The MACD's result once it has one, as the indicator declares it in the registry: the strategy reads the field `macdSrc` names, so a
 * field renamed in the indicator fails its type check rather than make it read undefined
 */
export type MACDResult = NonNullable<IndicatorRegistry['MACD']['output']>;
