import { Candle } from '@models/candle.types';
import { CandleBucket } from '@models/event.types';
import { OrderSide, OrderState } from '@models/order.types';
import { Portfolio } from '@models/portfolio.types';
import { Trade } from '@models/trade.types';
import { TradingPair } from '@models/utility.types';
import z from 'zod';
import type { binanceExchangeSchema } from './binance/binance.schema';
import type { exchangeSchema } from './exchange.schema';
import type { hyperliquidExchangeSchema } from './hyperliquid/hyperliquid.schema';

export type ExchangeConfig = z.infer<typeof exchangeSchema>;
type BinanceExchangeConfig = z.infer<typeof binanceExchangeSchema>;
type HyperliquidExchangeConfig = z.infer<typeof hyperliquidExchangeSchema>;
export type CCXTExchangeConfig = BinanceExchangeConfig | HyperliquidExchangeConfig;

export type MarketValidationResult<T> = { isValid: true; value: T } | { isValid: false; reason: string; min?: number; max?: number };

export interface Ticker {
  bid: number;
  ask: number;
}

export interface ExchangeDataLimits {
  candles: number;
  trades: number;
  orders: number;
}

interface MarketLimitRange {
  min?: number;
  max?: number;
}

interface MarketPrecision {
  price?: number;
  amount?: number;
  /**
   * The significant digits a price has at most where the tick depends on the price: Hyperliquid's 5, an integer part of more digits being
   * kept whole (see PRICE_SIGNIFICANT_DIGITS). The tick at a price is the larger of one unit of its last significant digit (0.001 at
   * 12.345, 0.1 at 1234.5, 1 from 10000 on) and precision.price, and a price rounded to it is sent as it is. precision.price alone is
   * the tick at the price the markets were loaded at, finer than the exchange's above the next power of ten: on a market loaded at 9990,
   * 10000.3 and 10000.4, a precision.price apart, were both sent at 10000.
   */
  priceSignificantDigits?: number;
}

interface MarketFee {
  maker?: number;
  taker?: number;
}

export interface MarketData {
  price?: MarketLimitRange;
  amount?: MarketLimitRange;
  cost?: MarketLimitRange;
  /**
   * The amount limits of a market order, which narrow the amount range for it (see getMarketOrderLimits): Binance's MARKET_LOT_SIZE
   * filter, which it applies to a MARKET order on top of LOT_SIZE (the amount range), with a far lower maximum on a liquid pair. A
   * dummy-cex configuration states it as `market` in a marketData entry, either bound optional, for a backtest to rehearse it.
   */
  market?: MarketLimitRange;
  /**
   * The steps an order's price and amount are multiples of, 0.01 for a price to the cent, as ccxt gives them for Binance and
   * Hyperliquid (both in its TICK_SIZE precision mode). A dummy-cex configuration states numbers of decimals instead (2 for 0.01),
   * which its schema turns into these steps. Hyperliquid's price step also depends on the price: see priceSignificantDigits.
   */
  precision?: MarketPrecision;
  fee?: MarketFee;
}

export type FetchOHLCVParams = {
  from?: EpochTimeStamp;
  timeframe?: string;
  limit?: number;
};

export type OrderSettledCallback = (orderState: OrderState) => void;

/**
 * The type of an order open on the exchange: LIMIT, an order resting in the book at its price; MARKET, one executed at the market,
 * which an exchange lists as open for an instant at most; OTHER, any other order, none of which Gekko places: a stop-loss or a
 * take-profit, waiting off the book for its trigger price, or an order of a type Gekko does not know, or of none.
 */
export type OpenOrderType = 'LIMIT' | 'MARKET' | 'OTHER';

/**
 * An order open on the exchange, as fetchOpenOrders lists it: placed, neither executed in full nor canceled. Gekko may know nothing
 * of it: one placed by a previous run, by hand or by another bot.
 */
export type OpenOrder = {
  id: string;
  side: OrderSide;
  type: OpenOrderType;
  /** Its limit price, undefined for an order without one, such as a stop-loss that executes at the market */
  price?: number;
  /** The amount ordered, in the asset of the pair */
  amount: number;
  /** The part of the amount executed so far */
  filled: number;
  /** The part of the amount still to execute, which the order holds on the exchange */
  remaining: number;
  /**
   * When the order was placed. From an exchange that does not date it, its last update, or, without one either, when it was read: it
   * was placed by then.
   */
  timestamp: EpochTimeStamp;
};

export interface Exchange {
  fetchTickers(symbols: TradingPair[]): Promise<Record<TradingPair, Ticker>>;
  fetchTicker(symbol: TradingPair): Promise<Ticker>;
  fetchOHLCV(symbol: TradingPair, params?: FetchOHLCVParams): Promise<Candle[]>;
  fetchMyTrades(symbol: TradingPair, from?: EpochTimeStamp): Promise<Trade[]>;
  fetchBalance(): Promise<Portfolio>;
  getExchangeName(): string;
  getMarketData(symbol: TradingPair): MarketData;
  createLimitOrder(
    symbol: TradingPair,
    side: OrderSide,
    amount: number,
    price: number,
    onSettled?: OrderSettledCallback,
  ): Promise<OrderState>;
  createMarketOrder(symbol: TradingPair, side: OrderSide, amount: number): Promise<OrderState>;
  /**
   * Resolves with the state of the order once the exchange has accepted the cancelation, its id included: 'canceled' with the amount
   * filled until then, 'closed' if it was executed in full first, or 'open' if the exchange has not completed the cancelation yet,
   * an order still to be polled. Rejects with OrderNotFound for an order the exchange does not know, which a real exchange also
   * answers for an order already executed or canceled.
   */
  cancelOrder(symbol: TradingPair, id: string): Promise<OrderState>;
  loadMarkets(): Promise<void>;
  fetchOrder(symbol: TradingPair, id: string): Promise<OrderState>;
  /**
   * The orders open on the pair, whoever placed them: a read, which cancels nothing. A simulator lists its own orders only, and a
   * backtest or a paper session starts with none.
   */
  fetchOpenOrders(symbol: TradingPair): Promise<OpenOrder[]>;
}

export type DummyExchange = Exchange & { processOneMinuteBucket: (bucket: CandleBucket) => Promise<void> };
