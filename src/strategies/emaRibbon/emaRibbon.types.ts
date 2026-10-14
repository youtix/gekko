import { z } from 'zod';
import type { emaRibbonStrategySchema } from './emaRibbon.schema';

export type EMARibbonStrategyParams = z.infer<typeof emaRibbonStrategySchema>;
