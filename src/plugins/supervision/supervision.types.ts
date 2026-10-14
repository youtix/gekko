import { z } from 'zod';
import type { supervisionSchema } from './supervision.schema';

export const SUBSCRIPTION_NAMES = ['cpu_check', 'memory_check', 'candle_check', 'monitor_log'] as const;

export type Subscription = (typeof SUBSCRIPTION_NAMES)[number];

export type SupervisionConfig = z.infer<typeof supervisionSchema>;
