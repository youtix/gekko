import { ONE_MINUTE } from '@constants/time.const';
import { drop } from 'lodash-es';
import { generateSyntheticCandle, generateSyntheticHistory } from '../fixtures/syntheticData';

export type PartialCandle = {
  close: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
};

export class MockCCXTExchange {
  private age = new Map<string, number>();
  private lastCandleTimestamp = new Map<string, number>();
  public static simulatedGaps: { start: number; end: number }[] | Record<string, { start: number; end: number }[]> = [];
  public static shouldThrowError: boolean = false;
  public static shouldThrowOnCreateOrder: boolean = false;
  /** When true, fetchOHLCV will emit each candle twice (simulating reconnection overlap) */
  public static emitDuplicatesEveryXCandle: number = 0;
  /** When true, fetchOHLCV will include a candle with a future timestamp (> Date.now()) */
  public static emitFutureCandles: boolean = false;
  /** When true, createOrder will return 'open' status and not fill the order immediately */
  public static simulateOpenOrders: boolean = false;

  public static predefinedCandles: Record<string, PartialCandle[]> = {};
  public static predefinedCandlesIndex: Record<string, number> = {};

  public static setPredefinedCandles(symbol: string, candles: PartialCandle[]) {
    this.predefinedCandles[symbol] = candles;
    this.predefinedCandlesIndex[symbol] = 0;
  }

  public static resetPredefinedCandles() {
    this.predefinedCandles = {};
    this.predefinedCandlesIndex = {};
  }

  /** Puts every static back as it is at load, so that a test does not run on the exchange the previous one set up */
  public static reset() {
    this.simulatedGaps = [];
    this.shouldThrowError = false;
    this.shouldThrowOnCreateOrder = false;
    this.emitDuplicatesEveryXCandle = 0;
    this.emitFutureCandles = false;
    this.simulateOpenOrders = false;
    this.mockTrades = [];
    this.resetPredefinedCandles();
  }

  public id = 'binance';
  public name = 'binance';
  public has = {
    fetchOHLCV: true,
    fetchTickers: true,
    fetchTicker: true,
    createOrder: true,
    createLimitOrder: true,
    createMarketOrder: true,
    fetchMyTrades: true,
    fetchBalance: true,
    fetchOpenOrders: true,
    fetchOrder: true,
    cancelOrder: true,
  };

  public markets: Record<
    string,
    {
      symbol: string;
      base: string;
      quote: string;
      baseName: string;
      limits: {
        price: { min: number; max: number };
        amount: { min: number; max: number };
        cost: { min: number; max: number };
      };
      precision: { price: number; amount: number };
    }
  > = {
    'BTC/USDT': {
      symbol: 'BTC/USDT',
      base: 'BTC',
      quote: 'USDT',
      baseName: 'BTC',
      limits: {
        price: { min: 0.1, max: 1000000 },
        amount: { min: 0.0001, max: 1000 },
        cost: { min: 5, max: 1000000 },
      },
      precision: { price: 0.01, amount: 0.000001 },
    },
    'ETH/USDT': {
      symbol: 'ETH/USDT',
      base: 'ETH',
      quote: 'USDT',
      baseName: 'ETH',
      limits: {
        price: { min: 0.01, max: 100000 },
        amount: { min: 0.001, max: 10000 },
        cost: { min: 5, max: 1000000 },
      },
      precision: { price: 0.01, amount: 0.000001 },
    },
    'LTC/USDT': {
      symbol: 'LTC/USDT',
      base: 'LTC',
      quote: 'USDT',
      baseName: 'LTC',
      limits: {
        price: { min: 0.01, max: 100000 },
        amount: { min: 0.001, max: 10000 },
        cost: { min: 5, max: 1000000 },
      },
      precision: { price: 0.01, amount: 0.000001 },
    },
  };

  /** Built as a ccxt client is, with its options, which the mock does not read */
  constructor(_config: any) {}

  async loadMarkets() {
    return this.markets;
  }

  /** ccxt options bag, read and written by CCXTExchange.loadMarkets (Hyperliquid's learned spotCurrencyMapping) */
  public options: Record<string, unknown> = {};

  /** ccxt shares the loaded catalogue of another client instead of downloading it again (CCXTExchange.loadMarkets) */
  setMarketsFromExchange(source: MockCCXTExchange) {
    this.markets = source.markets;
    return this;
  }

  market(symbol: string) {
    if (!this.markets[symbol]) {
      // Return default if not found
      return {
        limits: {
          price: { min: 0, max: Infinity },
          amount: { min: 0, max: Infinity },
          cost: { min: 0, max: Infinity },
        },
        precision: { price: 1e-8, amount: 1e-8 },
      };
    }
    return this.markets[symbol];
  }

  async fetchTickers(symbols: string[]) {
    const tickers: Record<string, any> = {};
    for (const symbol of symbols) {
      tickers[symbol] = await this.fetchTicker(symbol);
    }
    return tickers;
  }

  async fetchTicker(symbol: string) {
    const candle = generateSyntheticCandle(symbol, Date.now());
    return {
      symbol,
      timestamp: Date.now(),
      datetime: new Date().toISOString(),
      high: candle.high,
      low: candle.low,
      bid: candle.close, // Simplify bid/ask/last to close price
      ask: candle.close,
      last: candle.close,
      close: candle.close,
      baseVolume: candle.volume,
    };
  }

  async fetchOHLCV(symbol: string, _timeframe: string, since: number, limit: number) {
    if (MockCCXTExchange.shouldThrowError) throw new Error('Simulated Network Error');

    // PREDEFINED CANDLES OVERRIDE
    if (MockCCXTExchange.predefinedCandles[symbol] && MockCCXTExchange.predefinedCandles[symbol].length > 0) {
      const idx = MockCCXTExchange.predefinedCandlesIndex[symbol] || 0;
      if (idx < MockCCXTExchange.predefinedCandles[symbol].length) {
        const pc = MockCCXTExchange.predefinedCandles[symbol][idx];
        MockCCXTExchange.predefinedCandlesIndex[symbol] = idx + 1;

        const timestamp = since || Date.now();
        const open = pc.open ?? pc.close;
        const high = pc.high ?? Math.max(open, pc.close);
        const low = pc.low ?? Math.min(open, pc.close);
        const close = pc.close;
        const volume = pc.volume ?? 50;

        const result = [[timestamp, open, high, low, close, volume]];
        this.age.set(symbol, (this.age.get(symbol) ?? 0) + 1);
        return result;
      }
      // If exhausted, we gracefully fall through to synthetic generation below
    }

    // Like an exchange, serve the candles starting at the first minute at or after `since`: a request from the millisecond
    // after the last candle received (the next page) starts at the next minute
    const from = since || Date.now() - limit * ONE_MINUTE;
    const candles = generateSyntheticHistory(symbol, Math.ceil(from / ONE_MINUTE) * ONE_MINUTE, limit || 100);

    // Filter out gaps logic
    const filteredCandles = candles.filter(c => {
      // Check if candle start time is strictly inside any simulated gap
      // Use static property to check gaps
      const gaps = Array.isArray(MockCCXTExchange.simulatedGaps)
        ? MockCCXTExchange.simulatedGaps
        : MockCCXTExchange.simulatedGaps[symbol] || [];

      return !gaps.some(gap => c.start >= gap.start && c.start < gap.end);
    });

    // Map objects back to array format [timestamp, open, high, low, close, volume]
    let result = filteredCandles.map(c => [c.start, c.open, c.high, c.low, c.close, c.volume]);

    // If emitDuplicates is true, duplicate each candle (simulating reconnection overlap)
    if (MockCCXTExchange.emitDuplicatesEveryXCandle !== 0) {
      if ((this.age.get(symbol) ?? 0) % MockCCXTExchange.emitDuplicatesEveryXCandle === 0) {
        const timestamp = this.lastCandleTimestamp.get(symbol);
        if (timestamp) result = result.map(c => [timestamp, ...drop(c, 1)]);
        this.lastCandleTimestamp.set(symbol, result?.[0]?.[0]);
      }
    }

    // If emitFutureCandles is true, add a candle with a future timestamp
    if (MockCCXTExchange.emitFutureCandles) {
      const futureTimestamp = Date.now() + 5 * ONE_MINUTE;
      const futureCandle = generateSyntheticCandle(symbol, futureTimestamp);
      result = [
        [futureCandle.start, futureCandle.open, futureCandle.high, futureCandle.low, futureCandle.close, futureCandle.volume],
        ...result,
      ];
    }

    this.age.set(symbol, (this.age.get(symbol) ?? 0) + 1);
    return result;
  }

  public static mockTrades: any[] = [];

  // Private API mocks
  async fetchMyTrades(_symbol: string) {
    return MockCCXTExchange.mockTrades;
  }

  async fetchBalance() {
    return {
      USDT: { free: 10000, used: 0, total: 10000 },
      BTC: { free: 1, used: 0, total: 1 },
      ETH: { free: 10, used: 0, total: 10 },
      LTC: { free: 10, used: 0, total: 10 },
    };
  }

  async createOrder(symbol: string, type: string, side: string, amount: number, price?: number) {
    if (MockCCXTExchange.shouldThrowError || MockCCXTExchange.shouldThrowOnCreateOrder) {
      throw new Error('Simulated Network Error');
    }

    const id = Math.random().toString(36).substring(7);
    const timestamp = Date.now();
    if (MockCCXTExchange.simulateOpenOrders) {
      return {
        id,
        symbol,
        type,
        side,
        amount,
        price: price || 0,
        cost: (price || 0) * amount,
        status: 'open',
        timestamp,
        datetime: new Date(timestamp).toISOString(),
        filled: 0,
        remaining: amount,
        fee: undefined, // Fee not charged yet
        info: {},
      };
    }

    const trade = {
      id: Math.random().toString(36).substring(7),
      order: id,
      symbol,
      side,
      amount,
      price: price || 100, // Default price if market order
      cost: (price || 100) * amount,
      fee: { currency: 'USDT', cost: 0.1, rate: 0.001 },
      timestamp,
      datetime: new Date(timestamp).toISOString(),
    };
    MockCCXTExchange.mockTrades.push(trade);

    return {
      id,
      symbol,
      type,
      side,
      amount,
      price: price || 0,
      cost: (price || 0) * amount,
      status: 'closed',
      timestamp,
      datetime: new Date(timestamp).toISOString(),
      filled: amount,
      remaining: 0,
      fee: { currency: 'USDT', cost: 0.1, rate: 0.001 },
      info: {},
    };
  }

  async cancelOrder(id: string, symbol: string) {
    return {
      id,
      symbol,
      status: 'canceled',
      timestamp: Date.now(),
      datetime: new Date().toISOString(),
      info: {},
    };
  }

  async fetchOrder(id: string, symbol: string) {
    return {
      id,
      symbol,
      status: 'closed',
      timestamp: Date.now(),
      datetime: new Date().toISOString(),
      amount: 1,
      filled: 1,
      remaining: 0,
      price: 100,
      cost: 100,
      type: 'limit',
      side: 'buy',
      info: {},
    };
  }

  async fetchOpenOrders(_symbol: string) {
    return [];
  }
}

/**
 * ccxt's error classes, with ccxt's own inheritance (NetworkError extends OperationFailed, OrderNotFound extends InvalidOrder, BadSymbol
 * extends BadRequest), so that translateCcxtError (src/services/exchange/exchange.utils.ts) and the creations of CCXTExchange can run
 * their instanceof checks against the mocked module.
 */
export class MockOperationFailed extends Error {}
export class MockNetworkError extends MockOperationFailed {}
export class MockExchangeError extends Error {}
export class MockInvalidOrder extends MockExchangeError {}
export class MockOrderNotFound extends MockInvalidOrder {}
export class MockInsufficientFunds extends MockExchangeError {}
export class MockBadRequest extends MockExchangeError {}
export class MockBadSymbol extends MockBadRequest {}

const mockCcxtErrorClasses = {
  OperationFailed: MockOperationFailed,
  NetworkError: MockNetworkError,
  ExchangeError: MockExchangeError,
  InvalidOrder: MockInvalidOrder,
  OrderNotFound: MockOrderNotFound,
  InsufficientFunds: MockInsufficientFunds,
  BadRequest: MockBadRequest,
  BadSymbol: MockBadSymbol,
};

/** The module to hand to `mock.module('ccxt', ...)`: the exchange class and the error classes, as default and named exports */
export const createCcxtModuleMock = () => ({
  default: { binance: MockCCXTExchange, ...mockCcxtErrorClasses },
  binance: MockCCXTExchange,
  ...mockCcxtErrorClasses,
});
