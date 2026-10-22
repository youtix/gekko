import { z } from 'zod';
import type { tradingAdvisorSchema } from '@gekko/schemas/plugins/tradingAdvisor.schema';

export type TradingAdvisorConfiguration = z.infer<typeof tradingAdvisorSchema>;
