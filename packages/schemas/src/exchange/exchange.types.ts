import z from 'zod';
import type { binanceExchangeSchema } from './binance.schema';
import type { exchangeSchema } from './exchange.schema';
import type { hyperliquidExchangeSchema } from './hyperliquid.schema';

// The types of the exchange sections, as their schemas parse them. The types of the exchanges themselves (MarketData, Ticker, OpenOrder,
// Exchange and the others, written by hand) are in @gekko/shared/models/exchange.types.

/** The options every exchange section has, whatever its exchange (see exchangeSchema) */
export type ExchangeConfig = z.infer<typeof exchangeSchema>;
type BinanceExchangeConfig = z.infer<typeof binanceExchangeSchema>;
type HyperliquidExchangeConfig = z.infer<typeof hyperliquidExchangeSchema>;
/** The section of an exchange that CCXTExchange reaches through ccxt: Binance or Hyperliquid */
export type CCXTExchangeConfig = BinanceExchangeConfig | HyperliquidExchangeConfig;
