import z from 'zod';
import type { binanceExchangeSchema } from './binance.schema';
import type { exchangeSchema } from './exchange.schema';
import type { hyperliquidExchangeSchema } from './hyperliquid.schema';

export type ExchangeConfig = z.infer<typeof exchangeSchema>;
type BinanceExchangeConfig = z.infer<typeof binanceExchangeSchema>;
type HyperliquidExchangeConfig = z.infer<typeof hyperliquidExchangeSchema>;
export type CCXTExchangeConfig = BinanceExchangeConfig | HyperliquidExchangeConfig;
