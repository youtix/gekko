import z from 'zod';
import type { paperBinanceExchangeSchema } from './paperTradingBinanceExchange.schema';

export type PaperTradingBinanceExchangeConfig = z.infer<typeof paperBinanceExchangeSchema>;
