import type { IndicatorResults } from '@strategies/strategy.types';
import { z } from 'zod';
import type { emaRibbonStrategySchema } from './emaRibbon.schema';

export type EMARibbonStrategyParams = z.infer<typeof emaRibbonStrategySchema>;

export type RibbonResults = IndicatorResults<IndicatorRegistry['EMARibbon']['output']>;
