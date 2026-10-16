import { ONE_MINUTE } from '@constants/time.const';
import { Candle } from '@models/candle.types';
import { generateSyntheticCandle, syntheticPrice } from '../fixtures/syntheticData';
import { minuteOf } from '../helpers/clock.helper';

export type PartialCandle = {
  close: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
};

/** A candle as ccxt hands it over: [timestamp, open, high, low, close, volume] */
export type OHLCV = [number, number, number, number, number, number];

/** Minutes without a candle, from `start` (included) to `end` (excluded), in epoch milliseconds */
export type Gap = { start: number; end: number };

type Range = { min: number; max: number };

type MockMarket = {
  symbol: string;
  base: string;
  quote: string;
  baseName: string;
  maker: number;
  taker: number;
  limits: { price: Range; amount: Range; cost: Range; market: Range };
  precision: { price: number; amount: number };
};

/**
 * ccxt's error classes, with ccxt's own inheritance (BaseError at the root, NetworkError extends OperationFailed, OrderNotFound extends
 * InvalidOrder, BadSymbol extends BadRequest) and names ('NetworkError'), so that retry, translateCcxtError
 * (src/services/exchange/exchange.utils.ts) and the creations of CCXTExchange run their instanceof checks against the mocked module,
 * and a failure reads as ccxt's.
 */
export class MockBaseError extends Error {
  constructor(message?: string) {
    super(message);
    // As ccxt names each of its errors: after its class
    this.name = new.target.name.replace(/^Mock/, '');
  }
}
export class MockOperationFailed extends MockBaseError {}
export class MockNetworkError extends MockOperationFailed {}
export class MockExchangeError extends MockBaseError {}
export class MockInvalidOrder extends MockExchangeError {}
export class MockOrderNotFound extends MockInvalidOrder {}
export class MockInsufficientFunds extends MockExchangeError {}
export class MockBadRequest extends MockExchangeError {}
export class MockBadSymbol extends MockBadRequest {}

/** The fees ccxt 4.5.39 gives every Binance spot market (fees.trading of binance.js): 0.1 % for the maker and for the taker */
const BINANCE_SPOT_FEES = { maker: 0.001, taker: 0.001 };

/** ccxt's binance asks for 500 candles when no limit is given, and for 1000 at most (binance.fetchOHLCV) */
const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 1000;

const toOHLCV = ({ start, open, high, low, close, volume }: Candle): OHLCV => [start, open, high, low, close, volume];

export class MockCCXTExchange {
  /** The pages fetchOHLCV served each pair, which the duplicate lie counts */
  private pagesServed = new Map<string, number>();
  /** The first minute fetchOHLCV served each pair, which the duplicate lie stamps its pages with */
  private firstMinuteServed = new Map<string, number>();

  /**
   * The minutes the exchange has no candle for: for every pair (a list) or by pair (a record). The candles after a gap are served as
   * the exchange serves them, from the first at or after `since`, and a gap without an end (Infinity) ends the history of the pair, as
   * a delisting does.
   */
  public static simulatedGaps: Gap[] | Record<string, Gap[]> = [];
  /** When true, every call to fetchOHLCV and createOrder fails with a ccxt NetworkError, which CCXTExchange retries for a read only */
  public static shouldThrowError: boolean = false;
  /** The next calls to fetchOHLCV that fail with a ccxt NetworkError, one less after each: a fault that passes, which a retry gets past */
  public static networkErrorsToThrow: number = 0;
  /** When true, every call to fetchOHLCV fails with a ccxt ExchangeError, which CCXTExchange neither sends again nor translates */
  public static shouldThrowExchangeError: boolean = false;
  /** When true, every call to createOrder fails with a ccxt NetworkError */
  public static shouldThrowOnCreateOrder: boolean = false;
  /**
   * A lie of the exchange, for the scenarios that check what guards against it: from the X-th page served to a pair, every X-th page
   * (pages counted from 0) has each of its candles stamped with the first minute served to the pair, the prices of the minutes asked
   * for kept. ccxt's own parseOHLCVs, which keeps the candles at or after `since` only, never lets such a page through; RealtimeStream
   * drops each of its candles as already delivered. 0 tells no such lie.
   */
  public static emitDuplicatesEveryXCandle: number = 0;
  /**
   * A lie of the exchange, for the scenarios that check what guards against it: every page opens with the candle of 5 minutes after
   * the call, off the minute boundaries, before the candles asked for. Binance has no candle after the minute in progress, so ccxt
   * never serves one; RealtimeStream ignores it as a minute not closed yet.
   */
  public static emitFutureCandles: boolean = false;

  /**
   * A script of candles by pair, which fetchOHLCV serves one per call, in order, each stamped with the `since` of its call, instead of
   * a page; the synthetic pages follow the last one. The pair's ticker follows them (see lastPrice).
   */
  public static predefinedCandles: Record<string, PartialCandle[]> = {};
  /** The index of the next predefined candle of each pair, which is also how many of them were served */
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
    this.networkErrorsToThrow = 0;
    this.shouldThrowExchangeError = false;
    this.shouldThrowOnCreateOrder = false;
    this.emitDuplicatesEveryXCandle = 0;
    this.emitFutureCandles = false;
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

  /**
   * The markets as ccxt's binance builds them, the fields CCXTExchange.getMarketData reads: the maker and taker fees of a spot market,
   * and limits.market, Binance's MARKET_LOT_SIZE, whose maximum is lower than LOT_SIZE's (limits.amount) and whose minimum Binance
   * leaves at 0. Without them getMarketData gave no fee and no market range: the simulator of paper trading charged nothing, and the
   * paper flows pinned figures without fees.
   */
  public markets: Record<string, MockMarket> = {
    'BTC/USDT': {
      symbol: 'BTC/USDT',
      base: 'BTC',
      quote: 'USDT',
      baseName: 'BTC',
      ...BINANCE_SPOT_FEES,
      limits: {
        price: { min: 0.1, max: 1000000 },
        amount: { min: 0.0001, max: 1000 },
        cost: { min: 5, max: 1000000 },
        market: { min: 0, max: 100 },
      },
      precision: { price: 0.01, amount: 0.000001 },
    },
    'ETH/USDT': {
      symbol: 'ETH/USDT',
      base: 'ETH',
      quote: 'USDT',
      baseName: 'ETH',
      ...BINANCE_SPOT_FEES,
      limits: {
        price: { min: 0.01, max: 100000 },
        amount: { min: 0.001, max: 10000 },
        cost: { min: 5, max: 1000000 },
        market: { min: 0, max: 2000 },
      },
      precision: { price: 0.01, amount: 0.000001 },
    },
    'LTC/USDT': {
      symbol: 'LTC/USDT',
      base: 'LTC',
      quote: 'USDT',
      baseName: 'LTC',
      ...BINANCE_SPOT_FEES,
      limits: {
        price: { min: 0.01, max: 100000 },
        amount: { min: 0.001, max: 10000 },
        cost: { min: 5, max: 1000000 },
        market: { min: 0, max: 5000 },
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

  /**
   * The last price of the pair, as a ticker follows the candles: for a pair given predefined candles, the close of the last one served,
   * the open of the first before any is; else the synthetic price at the time of the call. The ticker read the synthetic price alone:
   * in the paper flows, whose candles trade at 100, the Trader's price and the exchange.price of every order event were 10,000.
   */
  private static lastPrice(symbol: string): number {
    const candles = this.predefinedCandles[symbol] ?? [];
    if (!candles.length) return syntheticPrice(symbol, Date.now());
    const served = this.predefinedCandlesIndex[symbol] ?? 0;
    return served ? candles[served - 1].close : (candles[0].open ?? candles[0].close);
  }

  async fetchTickers(symbols: string[]) {
    const tickers: Record<string, any> = {};
    for (const symbol of symbols) {
      tickers[symbol] = await this.fetchTicker(symbol);
    }
    return tickers;
  }

  /** The last price as the bid, the ask and the last trade (see lastPrice) */
  async fetchTicker(symbol: string) {
    const price = MockCCXTExchange.lastPrice(symbol);
    const timestamp = Date.now();
    return { symbol, timestamp, datetime: new Date(timestamp).toISOString(), bid: price, ask: price, last: price, close: price };
  }

  /**
   * The 1-minute candles of the pair as ccxt's binance hands them over: sorted, from the first at or after `since`, `limit` of them at
   * most, or the latest ones without `since` (see existingMinutes); the timeframe is not read. A pair given predefined candles gets the
   * next one alone instead, until none is left. Each fault the statics set fails the call before anything is served.
   */
  async fetchOHLCV(symbol: string, _timeframe: string, since?: number, limit?: number): Promise<OHLCV[]> {
    if (MockCCXTExchange.shouldThrowExchangeError) throw new MockExchangeError('Simulated Exchange Error');
    if (MockCCXTExchange.shouldThrowError) throw new MockNetworkError('Simulated Network Error');
    if (MockCCXTExchange.networkErrorsToThrow > 0) {
      MockCCXTExchange.networkErrorsToThrow--;
      throw new MockNetworkError('Simulated Network Error');
    }

    const predefinedCandle = MockCCXTExchange.servePredefinedCandle(symbol, since);
    const page = predefinedCandle ? [predefinedCandle] : this.serveSyntheticPage(symbol, since, limit);
    this.pagesServed.set(symbol, (this.pagesServed.get(symbol) ?? 0) + 1);
    return page;
  }

  /** The next predefined candle of the pair, stamped with `since` (the time of the call without it), or undefined once all were served */
  private static servePredefinedCandle(symbol: string, since?: number): OHLCV | undefined {
    const candles = this.predefinedCandles[symbol] ?? [];
    const index = this.predefinedCandlesIndex[symbol] ?? 0;
    if (index >= candles.length) return undefined;
    this.predefinedCandlesIndex[symbol] = index + 1;

    const { open = candles[index].close, close, volume = 50 } = candles[index];
    const { high = Math.max(open, close), low = Math.min(open, close) } = candles[index];
    return [since ?? Date.now(), open, high, low, close, volume];
  }

  /** A page of synthetic candles (see existingMinutes), with the lies the statics tell */
  private serveSyntheticPage(symbol: string, since: number | undefined, limit: number | undefined): OHLCV[] {
    const size = Math.min(limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    let page = MockCCXTExchange.existingMinutes(symbol, since, size).map(start => toOHLCV(generateSyntheticCandle(symbol, start)));
    if (page.length && !this.firstMinuteServed.has(symbol)) this.firstMinuteServed.set(symbol, page[0][0]);

    const period = MockCCXTExchange.emitDuplicatesEveryXCandle;
    const pageNumber = this.pagesServed.get(symbol) ?? 0;
    const firstMinute = this.firstMinuteServed.get(symbol);
    if (period && pageNumber && pageNumber % period === 0 && firstMinute !== undefined)
      page = page.map(([, open, high, low, close, volume]): OHLCV => [firstMinute, open, high, low, close, volume]);

    if (MockCCXTExchange.emitFutureCandles) page = [toOHLCV(generateSyntheticCandle(symbol, Date.now() + 5 * ONE_MINUTE)), ...page];
    return page;
  }

  /**
   * The starts of the candles the exchange serves, `size` of them at most, from the first minute at or after `since`, or the latest ones
   * without it: every minute up to the one in progress, which Binance serves unfinished, none after it, and none of the gaps of the pair,
   * which the page goes on after. The mock cut its page to a window of `limit` minutes and took the gaps out of it, as no exchange
   * does: a gap longer than a page ended the history there, and the refusal of a gap longer than the gap filler fills was out of reach.
   */
  private static existingMinutes(symbol: string, since: number | undefined, size: number): number[] {
    const gaps = Array.isArray(this.simulatedGaps) ? this.simulatedGaps : (this.simulatedGaps[symbol] ?? []);
    const gapAt = (minute: number) => gaps.find(({ start, end }) => minute >= start && minute < end);
    const minuteInProgress = minuteOf(Date.now());
    const minutes: number[] = [];

    if (since === undefined) {
      for (let minute = minuteInProgress; minutes.length < size && Number.isFinite(minute); ) {
        const gap = gapAt(minute);
        if (gap) {
          // On to the last minute before the gap
          minute = Math.ceil(gap.start / ONE_MINUTE) * ONE_MINUTE - ONE_MINUTE;
        } else {
          minutes.push(minute);
          minute -= ONE_MINUTE;
        }
      }
      return minutes.reverse();
    }

    for (let minute = Math.ceil(since / ONE_MINUTE) * ONE_MINUTE; minutes.length < size && minute <= minuteInProgress; ) {
      const gap = gapAt(minute);
      if (gap) {
        // On to the first minute at or after the end of the gap: none after a gap without an end
        minute = Math.ceil(gap.end / ONE_MINUTE) * ONE_MINUTE;
      } else {
        minutes.push(minute);
        minute += ONE_MINUTE;
      }
    }
    return minutes;
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
      throw new MockNetworkError('Simulated Network Error');
    }

    const id = Math.random().toString(36).substring(7);
    const timestamp = Date.now();
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

const mockCcxtErrorClasses = {
  BaseError: MockBaseError,
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
