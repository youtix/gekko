import { z } from 'zod';
import type { configurationSchema, watchSchema } from '@services/configuration/configuration.schema';

export type Watch = z.infer<typeof watchSchema>;
export type Configuration = z.infer<typeof configurationSchema>;
export type Timeframe = Watch['timeframe'];
