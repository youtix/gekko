import { z } from 'zod';
import type { tradingAdvisorSchema } from './tradingAdvisor.schema';

export type TradingAdvisorConfiguration = z.infer<typeof tradingAdvisorSchema>;
