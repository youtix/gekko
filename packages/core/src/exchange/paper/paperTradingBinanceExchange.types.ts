import z from 'zod';
import type { paperBinanceExchangeSchema } from '@gekko/schemas/exchange/paperTradingBinanceExchange.schema';

export type PaperTradingBinanceExchangeConfig = z.infer<typeof paperBinanceExchangeSchema>;
