import type { IndicatorResults } from '../strategy.types';
import { z } from 'zod';
import type { emaRibbonStrategySchema } from '@gekko/schemas/strategies/emaRibbon.schema';

export type EMARibbonStrategyParams = z.infer<typeof emaRibbonStrategySchema>;

export type RibbonResults = IndicatorResults<IndicatorRegistry['EMARibbon']['output']>;
