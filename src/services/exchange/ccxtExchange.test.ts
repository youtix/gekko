import { GekkoError } from '@errors/gekko.error';
import { OrderOutOfRangeError } from '@errors/orderOutOfRange.error';
import { config } from '@services/configuration/configuration';
import * as logger from '@services/logger';
import { useTimeZone } from '@utils/date/date.mock';
import { assertOrderWithinLimits } from '@helpers/market/market.helper';
import ccxt from 'ccxt';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CCXTExchange } from './ccxtExchange';
import { BROKER_MAX_RETRIES_ON_FAILURE, LIMITS, MAX_MY_TRADES_PAGES } from './exchange.const';
import { ExchangeNetworkError, InvalidOrder, OrderNotFound, OrderOutcomeUnknown } from './exchange.error';
import { checkMandatoryFeatures, createExchange, mapCcxtOrderToOrder, mapCcxtTradeToTrade, mapOhlcvToCandles } from './exchange.helper';
import type { CCXTExchangeConfig } from './exchange.types';

vi.mock('@services/configuration/configuration', () => ({
  config: { getWatch: vi.fn(), getExchange: vi.fn() },
}));
vi.mock('@services/core/heart/heart');
// The real validation runs (vi.fn(impl) survives mockReset), spied to check how the exchange calls it
vi.mock('@helpers/market/market.helper', async importOriginal => {
  const actual = await importOriginal<typeof import('@helpers/market/market.helper')>();
  return { ...actual, assertOrderWithinLimits: vi.fn(actual.assertOrderWithinLimits) };
});

// retry, translateErrors and the translation of the ccxt errors are the real ones: the tests see the errors CCXTExchange throws
vi.mock('./exchange.helper', async importOriginal => ({
  ...(await importOriginal<typeof import('./exchange.helper')>()),
  createExchange: vi.fn(),
  checkMandatoryFeatures: vi.fn(),
  mapCcxtOrderToOrder: vi.fn(),
  mapCcxtTradeToTrade: vi.fn(),
  mapOhlcvToCandles: vi.fn(),
}));
vi.mock('@services/logger', () => ({ error: vi.fn(), warning: vi.fn(), debug: vi.fn() }));
// retry waits between its attempts, the tests do not
vi.mock('@utils/process/process.utils', () => ({ wait: vi.fn() }));

// The exchanges are mocked, the error classes are the real ones, and so are the pure rounding functions and constants of ccxt
vi.mock('ccxt', async importOriginal => {
  const { errors, functions } = await importOriginal<typeof import('ccxt')>();
  const has = {
    fetchOHLCV: true,
    fetchTicker: true,
    fetchMyTrades: true,
    fetchOrder: true,
    fetchOpenOrders: true,
    fetchBalance: true,
    createOrder: true,
    createLimitOrder: true,
    createMarketOrder: true,
    cancelOrder: true,
    loadMarkets: true,
    sandbox: true,
    market: true,
  };
  const MockExchange = vi.fn();
  MockExchange.prototype.has = has;
  MockExchange.prototype.setSandboxMode = vi.fn();
  MockExchange.prototype.loadMarkets = vi.fn();
  MockExchange.prototype.setMarketsFromExchange = vi.fn();
  MockExchange.prototype.fetchTicker = vi.fn();
  MockExchange.prototype.fetchTickers = vi.fn();
  MockExchange.prototype.fetchOHLCV = vi.fn();
  MockExchange.prototype.fetchMyTrades = vi.fn();
  MockExchange.prototype.fetchOrder = vi.fn();
  MockExchange.prototype.fetchOpenOrders = vi.fn();
  MockExchange.prototype.fetchBalance = vi.fn();
  MockExchange.prototype.createOrder = vi.fn();
  MockExchange.prototype.cancelOrder = vi.fn();
  MockExchange.prototype.market = vi.fn();
  MockExchange.prototype.amountToPrecision = vi.fn();
  MockExchange.prototype.priceToPrecision = vi.fn();
  // As ccxt sets them on every exchange instance, with the precision mode of Binance and Hyperliquid
  MockExchange.prototype.decimalToPrecision = vi.fn(functions.decimalToPrecision);
  MockExchange.prototype.numberToString = vi.fn(functions.numberToString);
  MockExchange.prototype.precisionMode = functions.TICK_SIZE;
  MockExchange.prototype.paddingMode = functions.NO_PADDING;
  MockExchange.prototype.options = {};

  return { ...errors, default: { ...errors, TRUNCATE: functions.TRUNCATE, binance: MockExchange, hyperliquid: MockExchange } };
});

const mockWatchConfig = { pairs: [{ symbol: 'BTC/USDT', timeframe: '1m' }] };
const binanceConfig = {
  name: 'binance' as const,
  apiKey: 'key',
  secret: 'secret',
  sandbox: false,
  verbose: false,
  exchangeSynchInterval: 10000,
  orderSynchInterval: 5000,
};
const hyperliquidConfig = {
  name: 'hyperliquid' as const,
  privateKey: 'pk',
  walletAddress: 'addr',
  sandbox: false,
  verbose: false,
  exchangeSynchInterval: 10000,
  orderSynchInterval: 5000,
};

describe('CCXTExchange', () => {
  beforeEach(() => {
    (config.getWatch as Mock).mockReturnValue(mockWatchConfig);

    // Mock createExchange to return both publicClient and privateClient
    (createExchange as Mock).mockImplementation(config => {
      const exchangeClass = (ccxt as any)[config.name];
      return {
        publicClient: new exchangeClass(),
        privateClient: new exchangeClass(),
      };
    });
  });

  describe('Constructor', () => {
    it.each`
      exchangeName     | config               | expectedName
      ${'binance'}     | ${binanceConfig}     | ${'binance'}
      ${'hyperliquid'} | ${hyperliquidConfig} | ${'hyperliquid'}
    `('initializes $exchangeName exchange correctly', ({ config: cfg, expectedName }) => {
      expect(new CCXTExchange(cfg).getExchangeName()).toBe(expectedName);
    });

    it.each`
      sandbox
      ${true}
      ${false}
    `('creates exchange with sandbox=$sandbox', ({ sandbox }) => {
      new CCXTExchange({ ...binanceConfig, sandbox });
      expect(createExchange).toHaveBeenCalledWith({ ...binanceConfig, sandbox });
    });

    it('throws when required feature is missing', () => {
      (checkMandatoryFeatures as Mock).mockImplementationOnce(() => {
        throw new Error('Missing fetchOHLCV feature');
      });
      expect(() => new CCXTExchange(binanceConfig)).toThrow('Missing fetchOHLCV feature');
    });
  });

  describe('loadMarkets', () => {
    const markets = { 'BTC/USDT': { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' } };
    // ccxt's built-in mapping of Hyperliquid's wrapped spot tokens, then the same completed by fetchCurrencies from the token list of
    // the exchange while the markets load: a token the built-in mapping lacks (UZZZ), one it maps otherwise (UPUMP)
    const builtInMapping = { UBTC: 'BTC', UPUMP: 'PUMP' };
    const learnedMapping = { UBTC: 'BTC', UPUMP: 'PMP', UZZZ: 'ZZZ' };
    let exchange: CCXTExchange;
    let publicInstance: any;
    let privateInstance: any;

    describe.each`
      exchangeName     | exchangeConfig       | mapping           | privateOptions
      ${'binance'}     | ${binanceConfig}     | ${undefined}      | ${{}}
      ${'hyperliquid'} | ${hyperliquidConfig} | ${builtInMapping} | ${{ spotCurrencyMapping: learnedMapping }}
    `('on $exchangeName', ({ exchangeConfig, mapping, privateOptions }) => {
      beforeEach(() => {
        exchange = new CCXTExchange(exchangeConfig);
        // createExchange creates the public client first. Each client gets spies and options of its own: the mocked ccxt shares
        // those of its prototype between instances
        [publicInstance, privateInstance] = (ccxt as any)[exchangeConfig.name].mock.instances.slice(-2);
        publicInstance.options = mapping ? { spotCurrencyMapping: { ...mapping } } : {};
        privateInstance.options = mapping ? { spotCurrencyMapping: { ...mapping } } : {};
        // As in ccxt, the public client sets its markets, and completes Hyperliquid's mapping, once the exchange has answered
        publicInstance.loadMarkets = vi.fn(async () => {
          await Promise.resolve();
          if (mapping) publicInstance.options.spotCurrencyMapping = { ...learnedMapping };
          publicInstance.markets = markets;
          return markets;
        });
        privateInstance.loadMarkets = vi.fn();
        privateInstance.setMarketsFromExchange = vi.fn((source: any) => {
          privateInstance.markets = source.markets;
          return privateInstance;
        });
      });

      it('downloads the markets once, with the public client', async () => {
        await exchange.loadMarkets();
        expect(publicInstance.loadMarkets).toHaveBeenCalledOnce();
      });

      it('does not download the markets with the private client', async () => {
        await exchange.loadMarkets();
        expect(privateInstance.loadMarkets).not.toHaveBeenCalled();
      });

      it('hands the private client the markets the public client loaded', async () => {
        await exchange.loadMarkets();
        expect(privateInstance.markets).toBe(markets);
      });

      // Hyperliquid's private client resolves a symbol written with the token name and keys its spot balance with that mapping
      it('gives the private client the spot currency mapping of the public client once loaded, if it has one', async () => {
        await exchange.loadMarkets();
        expect(privateInstance.options).toStrictEqual(privateOptions);
      });
    });
  });

  describe('Market Operations', () => {
    let exchange: CCXTExchange;
    let instance: any;

    beforeEach(() => {
      exchange = new CCXTExchange(binanceConfig);
      instance = (ccxt as any).binance.mock.instances.at(-1);
    });

    it('getMarketData returns market limits and fees (using first configured pair)', () => {
      instance.market.mockReturnValue({
        limits: { amount: { min: 0.1 }, price: { min: 1 }, cost: { min: 10 } },
        precision: { price: 2, amount: 4 },
        maker: 0.001,
        taker: 0.002,
      });
      expect(exchange.getMarketData('BTC/USDT')).toMatchObject({
        amount: { min: 0.1 },
        fee: { maker: 0.001, taker: 0.002 },
      });
      expect(instance.market).toHaveBeenCalledWith('BTC/USDT');
    });

    // Binance's MARKET_LOT_SIZE on BTCUSDT, which ccxt parses into limits.market: the simulator of paper trading is built from it
    it('getMarketData carries the amount limits of a market order', () => {
      instance.market.mockReturnValue({ limits: { amount: { min: 0.00001, max: 9000 }, market: { min: 0, max: 86.27382215 } } });
      expect(exchange.getMarketData('BTC/USDT').market).toEqual({ min: 0, max: 86.27382215 });
    });

    // ccxt's precision.price is Hyperliquid's tick at the price the markets were loaded at: the tick there depends on the price
    it.each`
      exchangeName     | exchangeConfig       | marketPrecision                     | expected
      ${'binance'}     | ${binanceConfig}     | ${{ price: 0.01, amount: 0.00001 }} | ${{ price: 0.01, amount: 0.00001 }}
      ${'hyperliquid'} | ${hyperliquidConfig} | ${{ price: 0.1, amount: 0.01 }}     | ${{ price: 0.1, amount: 0.01, priceSignificantDigits: 5 }}
    `('getMarketData states the precision of a $exchangeName market', ({ exchangeConfig, marketPrecision, expected }) => {
      instance.market.mockReturnValue({ limits: {}, precision: marketPrecision });
      expect(new CCXTExchange(exchangeConfig).getMarketData('BTC/USDC').precision).toEqual(expected);
    });

    it('getExchangeName returns configured name', () => {
      expect(exchange.getExchangeName()).toBe('binance');
    });
  });

  describe('fetchTickers', () => {
    // As ccxt 4.5.39 resolves them: a symbol to its market, whose unified symbol keys the ticker ccxt returns. A symbol written with
    // the name of a wrapped spot token of Hyperliquid (UBTC, UETH, USOL...) resolves to the market of the coin it wraps, UBTC/USDC to
    // BTC/USDC, and its ticker comes keyed BTC/USDC
    const unifiedSymbols: Record<string, string> = { 'BTC/USDT': 'BTC/USDT', 'UBTC/USDC': 'BTC/USDC', 'ETH/USDC': 'ETH/USDC' };
    const btc = { ask: 101, bid: 100, last: 100.5 };
    const eth = { ask: 3001, bid: 3000, last: 3000.5 };

    /** An exchange whose ccxt client resolves the symbols as above and answers fetchTickers with `tickers` */
    const exchangeWithTickers = (exchangeConfig: CCXTExchangeConfig, tickers: object) => {
      const exchange = new CCXTExchange(exchangeConfig);
      const instance = (ccxt as any)[exchangeConfig.name].mock.instances.at(-1);
      instance.market.mockImplementation((symbol: string) => ({ symbol: unifiedSymbols[symbol] }));
      instance.fetchTickers.mockResolvedValue(tickers);
      return exchange;
    };

    it.each`
      description                                                   | exchangeConfig       | symbol         | tickers
      ${'keys by the token name a ticker under the unified symbol'} | ${hyperliquidConfig} | ${'UBTC/USDC'} | ${{ 'BTC/USDC': btc }}
      ${'keys the ticker of a binance symbol by that symbol'}       | ${binanceConfig}     | ${'BTC/USDT'}  | ${{ 'BTC/USDT': btc }}
      ${'reads a ticker keyed by the symbol asked for itself'}      | ${hyperliquidConfig} | ${'UBTC/USDC'} | ${{ 'UBTC/USDC': btc }}
    `('$description', async ({ exchangeConfig, symbol, tickers }) => {
      expect(await exchangeWithTickers(exchangeConfig, tickers).fetchTickers([symbol])).toEqual({ [symbol]: { ask: 101, bid: 100 } });
    });

    it('keys the tickers of several symbols by those symbols', async () => {
      const exchange = exchangeWithTickers(hyperliquidConfig, { 'BTC/USDC': btc, 'ETH/USDC': eth });
      expect(await exchange.fetchTickers(['UBTC/USDC', 'ETH/USDC'])).toEqual({
        'UBTC/USDC': { ask: 101, bid: 100 },
        'ETH/USDC': { ask: 3001, bid: 3000 },
      });
    });

    it('gives a ticker without an ask or a bid its last price for both', async () => {
      const exchange = exchangeWithTickers(binanceConfig, { 'BTC/USDT': { ask: undefined, bid: undefined, last: 100.5 } });
      expect(await exchange.fetchTickers(['BTC/USDT'])).toEqual({ 'BTC/USDT': { ask: 100.5, bid: 100.5 } });
    });

    it.each`
      description                           | tickers
      ${'a ticker missing from the answer'} | ${{}}
      ${'a ticker without a last price'}    | ${{ 'BTC/USDC': { ...btc, last: undefined } }}
    `('rejects $description with a GekkoError naming the symbol asked for', async ({ tickers }) => {
      await expect(exchangeWithTickers(hyperliquidConfig, tickers).fetchTickers(['UBTC/USDC'])).rejects.toStrictEqual(
        new GekkoError('exchange', 'Fetch ticker failed to return data for UBTC/USDC'),
      );
    });
  });

  describe('fetchTicker', () => {
    let exchange: CCXTExchange;
    let instance: any;

    beforeEach(() => {
      exchange = new CCXTExchange(binanceConfig);
      instance = (ccxt as any).binance.mock.instances.at(-1);
    });

    it('returns formatted ticker with ask and bid', async () => {
      instance.fetchTicker.mockResolvedValue({ ask: 101, bid: 100, last: 100.5 });
      expect(await exchange.fetchTicker('BTC/USDT')).toEqual({ ask: 101, bid: 100 });
      expect(instance.fetchTicker).toHaveBeenCalledTimes(1);
      expect(instance.fetchTicker.mock.calls[0][0]).toBe('BTC/USDT');
    });

    it('throws when last price is nil', async () => {
      instance.fetchTicker.mockResolvedValue({ ask: null, bid: null, last: null });
      await expect(exchange.fetchTicker('BTC/USDT')).rejects.toThrow(GekkoError);
    });
  });

  describe('fetchOHLCV', () => {
    it('fetches and maps candles', async () => {
      const exchange = new CCXTExchange(binanceConfig);
      const instance = (ccxt as any).binance.mock.instances.at(-1);
      const ohlcv = [[1000, 1, 2, 1, 1.5, 100]];
      const candles = [{ start: 1000 }];
      instance.fetchOHLCV.mockResolvedValue(ohlcv);
      (mapOhlcvToCandles as Mock).mockReturnValue(candles);
      expect(await exchange.fetchOHLCV('BTC/USDT', { limit: 50, from: 1000 })).toEqual(candles);
      expect(instance.fetchOHLCV).toHaveBeenCalledWith('BTC/USDT', '1m', 1000, 50);
    });

    // How many candles a page holds, and the range they span. The line used to name the candles without their count, and to date an
    // empty page from 'Unknown Date' to 'Unknown Date'.
    describe('logging the page fetched', () => {
      /** `count` candles a minute apart, the first one starting at `start` */
      const candlesFrom = (start: number, count: number) => Array.from({ length: count }, (_, n) => ({ start: start + n * 60_000 }));
      let exchange: CCXTExchange;

      beforeEach(() => {
        exchange = new CCXTExchange(binanceConfig);
      });

      it.each`
        description       | candles                                    | message
        ${'1000 candles'} | ${candlesFrom(Date.UTC(2026, 9, 1), 1000)} | ${'Fetched 1000 BTC/USDT candles from binance. From 2026-10-01T00:00:00.000Z to 2026-10-01T16:39:00.000Z (16 hours 39 minutes)'}
        ${'1 candle'}     | ${candlesFrom(Date.UTC(2026, 9, 1), 1)}    | ${'Fetched 1 BTC/USDT candle from binance. From 2026-10-01T00:00:00.000Z to 2026-10-01T00:00:00.000Z'}
        ${'no candle'}    | ${[]}                                      | ${'Fetched 0 BTC/USDT candles from binance.'}
      `('logs a page of $description at debug level: $message', async ({ candles, message }) => {
        (mapOhlcvToCandles as Mock).mockReturnValue(candles);
        await exchange.fetchOHLCV('BTC/USDT');
        expect(logger.debug).toHaveBeenCalledWith('exchange', message);
      });

      // On 2026-10-25 Paris goes from 03:00 CEST back to 02:00 CET. Counted on the host's calendar, a page across that night came out
      // an hour short: 3 days 10 hours 19 minutes. On 2023-03-26 it skips from 02:00 CET to 03:00 CEST: through the TZDate of
      // @date-fns/tz for 'UTC', a page ending at 02:30Z that day, a wall-clock time Paris skips, came out at "1 day -1 hours".
      describe('on a host in Europe/Paris', () => {
        useTimeZone('Europe/Paris');

        it.each`
          description                         | start                           | count   | duration
          ${'across the end of DST'}          | ${Date.UTC(2026, 9, 24)}        | ${5000} | ${'3 days 11 hours 19 minutes'}
          ${'ending in the hour Paris skips'} | ${Date.UTC(2023, 2, 25, 2, 30)} | ${1441} | ${'1 day'}
        `('logs the duration of a page $description on the UTC calendar: $duration', async ({ start, count, duration }) => {
          (mapOhlcvToCandles as Mock).mockReturnValue(candlesFrom(start, count));
          await exchange.fetchOHLCV('BTC/USDT');
          expect(logger.debug).toHaveBeenCalledWith('exchange', expect.stringMatching(new RegExp(`\\(${duration}\\)$`)));
        });
      });
    });
  });

  describe('fetchMyTrades', () => {
    type TradeFixture = { id?: string; order: string; symbol: string; timestamp?: number; amount: number; price: number };
    const market = { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' };
    const trade = {
      id: '1',
      order: 'ord1',
      symbol: 'BTC/USDT',
      timestamp: 1000,
      amount: 1,
      price: 60000,
      fee: { cost: 60, currency: 'USDT' },
    };
    const { trades: limit } = LIMITS.binance;
    let exchange: CCXTExchange;
    let instance: any;

    /** A ccxt trade on BTC/USDT, a fill of the order ord1, unless overridden */
    const makeTrade = (id: string | undefined, timestamp: number | undefined, overrides: Partial<TradeFixture> = {}): TradeFixture => ({
      id,
      order: 'ord1',
      symbol: 'BTC/USDT',
      timestamp,
      amount: 1,
      price: 60000,
      ...overrides,
    });
    /** `count` trades of ids `${prefix}0`, `${prefix}1`..., each made at the time `time` gives its index */
    const makeTrades = (count: number, time: (index: number) => number, prefix = '', overrides: Partial<TradeFixture> = {}) =>
      Array.from({ length: count }, (_, index) => makeTrade(`${prefix}${index}`, time(index), overrides));
    /**
     * A trade history, oldest first, served a page a call as ccxt 4.5.39 returns it: the first `pageLimit` trades made at or after
     * `since`, the latest ones without it. Binance pages the trades of the symbol asked for. Given allMarketsPage, the exchange pages the
     * trades of every market, that many an answer, which ccxt then filters by the symbol asked for: Hyperliquid, 2000 fills an answer.
     */
    const serveHistory =
      (history: TradeFixture[], allMarketsPage?: number) =>
      async (symbol: string | undefined, since: number | undefined, pageLimit: number) => {
        const ofSymbol = (trades: TradeFixture[]) => (symbol === undefined ? trades : trades.filter(fill => fill.symbol === symbol));
        if (since === undefined) return ofSymbol(history).slice(-pageLimit);
        const fromSince = history.filter(({ timestamp }) => timestamp !== undefined && timestamp >= since);
        return ofSymbol(allMarketsPage ? fromSince.slice(0, allMarketsPage) : fromSince).slice(0, pageLimit);
      };
    const getSinceOfEachCall = () => instance.fetchMyTrades.mock.calls.map(([, since]: unknown[]) => since);

    // Two trades a millisecond from 1000: full pages from 1000 (trades 0 to 999) and 1499 (998 to 1997), then from 1998 (1996 to 2499)
    const threePages = makeTrades(2500, index => 1000 + Math.floor(index / 2));
    // More trades than a page holds, all made in the millisecond 1000
    const crowdedMillisecond = makeTrades(limit + 500, () => 1000);

    beforeEach(() => {
      exchange = new CCXTExchange(binanceConfig);
      instance = (ccxt as any).binance.mock.instances.at(-1);
      instance.market.mockImplementation((symbol: string) => (symbol === market.symbol ? market : undefined));
      instance.fetchMyTrades.mockResolvedValue([trade]);
      (mapCcxtTradeToTrade as Mock).mockImplementation(t => t);
    });

    it('fetches and maps trades', async () => {
      expect(await exchange.fetchMyTrades('BTC/USDT', 1000)).toEqual([trade]);
    });

    it('fetches the trades of the symbol since the date given', async () => {
      await exchange.fetchMyTrades('BTC/USDT', 1000);
      expect(instance.fetchMyTrades).toHaveBeenCalledWith('BTC/USDT', 1000, expect.anything());
    });

    // The mapper derives the fee rate of a trade from the currency of its fee, base or quote of the market
    it('maps each trade with the market of the symbol', async () => {
      await exchange.fetchMyTrades('BTC/USDT', 1000);
      expect(mapCcxtTradeToTrade).toHaveBeenCalledWith(trade, market);
    });

    it.each`
      description                                    | history                                         | from         | pages
      ${'a page that is not full'}                   | ${makeTrades(3, index => 1000 + index)}         | ${1000}      | ${1}
      ${'a full page, without a date to fetch from'} | ${makeTrades(limit + 1, index => 1000 + index)} | ${undefined} | ${1}
      ${'two full pages and one that is not'}        | ${threePages}                                   | ${1000}      | ${3}
      ${'a full page that brings no new trade'}      | ${crowdedMillisecond}                           | ${1000}      | ${2}
    `('fetches $pages page(s) for $description', async ({ history, from, pages }) => {
      instance.fetchMyTrades.mockImplementation(serveHistory(history));
      await exchange.fetchMyTrades('BTC/USDT', from);
      expect(instance.fetchMyTrades).toHaveBeenCalledTimes(pages);
    });

    describe('with trades beyond a full page', () => {
      beforeEach(() => {
        instance.fetchMyTrades.mockImplementation(serveHistory(threePages));
      });

      it('fetches each next page from the time of the last trade of the full page before', async () => {
        await exchange.fetchMyTrades('BTC/USDT', 1000);
        expect(getSinceOfEachCall()).toEqual([1000, 1499, 1998]);
      });

      it('returns each trade once, oldest first', async () => {
        expect(await exchange.fetchMyTrades('BTC/USDT', 1000)).toEqual(threePages);
      });

      it('does not warn', async () => {
        await exchange.fetchMyTrades('BTC/USDT', 1000);
        expect(logger.warning).not.toHaveBeenCalled();
      });
    });

    it('warns that the later trades are missing when a full page brings no new trade', async () => {
      instance.fetchMyTrades.mockImplementation(serveHistory(crowdedMillisecond));
      await exchange.fetchMyTrades('BTC/USDT', 1000);
      expect(logger.warning).toHaveBeenCalledWith('exchange', expect.stringContaining('cannot page past that time'));
    });

    // Pages of 2 trades, which keep MAX_MY_TRADES_PAGES pages cheap to fetch
    describe('with more trades than MAX_MY_TRADES_PAGES pages hold', () => {
      // A trade a millisecond: each page brings one new trade, its first one being the last one of the page before
      const longHistory = makeTrades(2 * MAX_MY_TRADES_PAGES + 2, index => 1000 + index);

      beforeEach(() => {
        LIMITS.binance.trades = 2;
        instance.fetchMyTrades.mockImplementation(serveHistory(longHistory));
      });

      afterEach(() => {
        LIMITS.binance.trades = limit;
      });

      it('fetches MAX_MY_TRADES_PAGES pages', async () => {
        await exchange.fetchMyTrades('BTC/USDT', 1000);
        expect(instance.fetchMyTrades).toHaveBeenCalledTimes(MAX_MY_TRADES_PAGES);
      });

      it('warns that the later trades are missing', async () => {
        await exchange.fetchMyTrades('BTC/USDT', 1000);
        expect(logger.warning).toHaveBeenCalledWith('exchange', expect.stringContaining(`stopped after ${MAX_MY_TRADES_PAGES} pages`));
      });
    });

    it('fetches the next page from the same time when the last trade of a full page has no time', async () => {
      instance.fetchMyTrades.mockResolvedValue([...makeTrades(limit - 1, index => 1000 + index), makeTrade('untimed', undefined)]);
      await exchange.fetchMyTrades('BTC/USDT', 1000);
      expect(getSinceOfEachCall()).toEqual([1000, 1000]);
    });

    // ccxt leaves the amount or the price of a trade undefined when the exchange gives none. Read as 0, an unknown price entered the
    // mean price of the order: fills of 0.5 at 100 and of 0.5 at an unknown price made a fill of 1 at 50.
    describe('with trades that do not say what they executed', () => {
      const executed = makeTrade('1', 1000);
      const withoutPrice = makeTrade('2', 1001, { price: undefined });
      const withoutAmount = makeTrade('3', 1002, { amount: undefined });

      beforeEach(() => {
        instance.fetchMyTrades.mockResolvedValue([executed, withoutPrice, withoutAmount]);
      });

      it('returns only the trade that does', async () => {
        expect(await exchange.fetchMyTrades('BTC/USDT', 1000)).toEqual([executed]);
      });

      it('warns once, naming the trades left out', async () => {
        await exchange.fetchMyTrades('BTC/USDT', 1000);
        expect(logger.warning).toHaveBeenCalledExactlyOnceWith(
          'exchange',
          '2 trades of BTC/USDT on binance left out, their amount or price not a number above 0: trade 2 of order ord1 (amount 1, price undefined), trade 3 of order ord1 (amount undefined, price 60000)',
        );
      });
    });

    it('keeps both sides of a self-trade, which share the id of the trade', async () => {
      instance.fetchMyTrades.mockResolvedValue([makeTrade('7', 1000, { order: 'buy' }), makeTrade('7', 1000, { order: 'sell' })]);
      expect(await exchange.fetchMyTrades('BTC/USDT', 1000)).toHaveLength(2);
    });

    // Two trades without an id, made in the same millisecond, end the first page and start the second one
    it('keeps once each trade without an id fetched on two pages', async () => {
      const idless = [makeTrade(undefined, 1998, { amount: 1 }), makeTrade(undefined, 1998, { amount: 2 })];
      const history = [...makeTrades(limit - 2, index => 1000 + index), ...idless, ...makeTrades(5, index => 1999 + index, 'tail')];
      instance.fetchMyTrades.mockImplementation(serveHistory(history));
      expect(await exchange.fetchMyTrades('BTC/USDT', 1000)).toHaveLength(limit + 5);
    });

    describe('on hyperliquid, whose pages hold the fills of every market', () => {
      const fillsPerAnswer = 2000;
      // A full answer of fills of a perpetual (1000 to 2999), then three fills of the symbol (3000 to 3002)
      const fillsOfSymbol = makeTrades(3, index => 3000 + index, 'btc', { symbol: 'BTC/USDC' });
      const history = [...makeTrades(fillsPerAnswer, index => 1000 + index, 'eth', { symbol: 'ETH/USDC:USDC' }), ...fillsOfSymbol];

      beforeEach(() => {
        exchange = new CCXTExchange(hyperliquidConfig);
        instance = (ccxt as any).hyperliquid.mock.instances.at(-1);
        instance.market.mockReturnValue({ symbol: 'BTC/USDC', base: 'BTC', quote: 'USDC' });
        instance.fetchMyTrades.mockImplementation(serveHistory(history, fillsPerAnswer));
      });

      it('fetches the fills of every market, 2000 a page', async () => {
        await exchange.fetchMyTrades('BTC/USDC', 1000);
        expect(instance.fetchMyTrades).toHaveBeenCalledWith(undefined, 1000, fillsPerAnswer);
      });

      it('finds the fills of the symbol beyond a full page of fills of other markets', async () => {
        expect(await exchange.fetchMyTrades('BTC/USDC', 1000)).toEqual(fillsOfSymbol);
      });
    });
  });

  describe('fetchOrder', () => {
    it('fetches and maps order', async () => {
      const exchange = new CCXTExchange(binanceConfig);
      const instance = (ccxt as any).binance.mock.instances.at(-1);
      instance.fetchOrder.mockResolvedValue({ id: '1' });
      (mapCcxtOrderToOrder as Mock).mockReturnValue({ id: '1' });
      expect(await exchange.fetchOrder('BTC/USDT', '1')).toEqual({ id: '1' });
      expect(instance.fetchOrder).toHaveBeenCalledWith('1', 'BTC/USDT');
    });
  });

  describe('fetchOpenOrders', () => {
    // As ccxt 4.5.39 parses the open orders of Binance (GET /api/v3/openOrders): a limit BUY of 2 at 95 with 0.5 filled, and a
    // stop_loss_limit SELL waiting for its trigger price
    const limitBuy = {
      id: '28457',
      symbol: 'BTC/USDT',
      status: 'open',
      type: 'limit',
      side: 'buy',
      price: 95,
      amount: 2,
      filled: 0.5,
      remaining: 1.5,
      timestamp: 1704346468838,
    };
    const stopLossLimitSell = {
      id: '28458',
      symbol: 'BTC/USDT',
      status: 'open',
      type: 'stop_loss_limit',
      side: 'sell',
      price: 89.5,
      triggerPrice: 90,
      amount: 1,
      filled: 0,
      remaining: 1,
      timestamp: 1704346470000,
    };
    let exchange: CCXTExchange;

    // Hyperliquid's open orders are public, but only the private client has the wallet address that tells whose to read
    describe.each`
      exchangeName     | exchangeConfig       | symbol
      ${'binance'}     | ${binanceConfig}     | ${'BTC/USDT'}
      ${'hyperliquid'} | ${hyperliquidConfig} | ${'UBTC/USDC'}
    `('on $exchangeName', ({ exchangeConfig, symbol }) => {
      let publicInstance: any;
      let privateInstance: any;

      beforeEach(() => {
        exchange = new CCXTExchange(exchangeConfig);
        // Spies of each client's own: the mocked ccxt shares those of its prototype between instances
        [publicInstance, privateInstance] = (ccxt as any)[exchangeConfig.name].mock.instances.slice(-2);
        publicInstance.fetchOpenOrders = vi.fn(async () => []);
        privateInstance.fetchOpenOrders = vi.fn(async () => []);
      });

      it('asks the private client for the open orders of the symbol', async () => {
        await exchange.fetchOpenOrders(symbol);
        expect(privateInstance.fetchOpenOrders).toHaveBeenCalledExactlyOnceWith(symbol);
      });

      it('does not ask the public client', async () => {
        await exchange.fetchOpenOrders(symbol);
        expect(publicInstance.fetchOpenOrders).not.toHaveBeenCalled();
      });
    });

    describe('on binance', () => {
      let instance: any;

      beforeEach(() => {
        exchange = new CCXTExchange(binanceConfig);
        instance = (ccxt as any).binance.mock.instances.at(-1);
      });

      it('returns no order when the exchange lists none', async () => {
        instance.fetchOpenOrders.mockResolvedValue([]);
        expect(await exchange.fetchOpenOrders('BTC/USDT')).toEqual([]);
      });

      it('returns each order the exchange lists, in its order, mapped', async () => {
        instance.fetchOpenOrders.mockResolvedValue([limitBuy, stopLossLimitSell]);
        expect(await exchange.fetchOpenOrders('BTC/USDT')).toEqual([
          { id: '28457', side: 'BUY', type: 'LIMIT', price: 95, amount: 2, filled: 0.5, remaining: 1.5, timestamp: 1704346468838 },
          { id: '28458', side: 'SELL', type: 'OTHER', price: 89.5, amount: 1, filled: 0, remaining: 1, timestamp: 1704346470000 },
        ]);
      });

      describe('listing an order without a side', () => {
        beforeEach(() => {
          instance.fetchOpenOrders.mockResolvedValue([limitBuy, { ...stopLossLimitSell, side: undefined }]);
        });

        it('rejects with a GekkoError naming that order', async () => {
          await expect(exchange.fetchOpenOrders('BTC/USDT')).rejects.toStrictEqual(
            new GekkoError(
              'exchange',
              'Open order 28458 on BTC/USDT has no side Gekko knows (undefined): the open orders of BTC/USDT cannot be listed, check it on the exchange',
            ),
          );
        });

        // A read is sent again after a NetworkError only
        it('does not ask the exchange again', async () => {
          await exchange.fetchOpenOrders('BTC/USDT').catch(() => undefined);
          expect(instance.fetchOpenOrders).toHaveBeenCalledOnce();
        });
      });
    });
  });

  describe('fetchBalance', () => {
    const btc = { free: 0.5, used: 0.1, total: 0.6 };
    const usd = { free: 1000, used: 200, total: 1200 };
    const other = { free: 12, used: 3, total: 15 };
    const zero = { free: 0, used: 0, total: 0 };

    describe('on binance, whose markets have no baseName', () => {
      let exchange: CCXTExchange;
      let instance: any;

      beforeEach(() => {
        exchange = new CCXTExchange(binanceConfig);
        instance = (ccxt as any).binance.mock.instances.at(-1);
        instance.market.mockReturnValue({ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' });
      });

      it.each`
        description                                                      | balance                    | expected
        ${'keys the balances by the asset and the currency of the pair'} | ${{ BTC: btc, USDT: usd }} | ${{ BTC: btc, USDT: usd }}
        ${'zeroes an asset absent from the balance'}                     | ${{ USDT: usd }}           | ${{ BTC: zero, USDT: usd }}
        ${'zeroes a currency absent from the balance'}                   | ${{ BTC: btc }}            | ${{ BTC: btc, USDT: zero }}
      `('$description', async ({ balance, expected }) => {
        instance.fetchBalance.mockResolvedValue(balance);
        expect(Object.fromEntries(await exchange.fetchBalance())).toEqual(expected);
      });

      it('looks the market up by the configured symbol', async () => {
        instance.fetchBalance.mockResolvedValue({ BTC: btc, USDT: usd });
        await exchange.fetchBalance();
        expect(instance.market).toHaveBeenCalledWith('BTC/USDT');
      });

      it('keys the balances of every watched pair', async () => {
        (config.getWatch as Mock).mockReturnValue({ pairs: [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }] });
        instance.market.mockImplementation((symbol: string) => ({ symbol, base: symbol.split('/')[0], quote: 'USDT' }));
        instance.fetchBalance.mockResolvedValue({ BTC: btc, ETH: other, USDT: usd });
        expect(Object.fromEntries(await exchange.fetchBalance())).toEqual({ BTC: btc, ETH: other, USDT: usd });
      });
    });

    describe('on hyperliquid, a wrapped spot token', () => {
      // As ccxt 4.5.39 builds them: the wrapped spot tokens (UBTC, UETH, USOL...) are listed under the coins they wrap, UBTC as
      // BTC/USDC (base BTC, baseName UBTC), their spot balance is keyed by those coins ({ USDC, BTC, HYPE }), and the symbol written
      // with the token name, UBTC/USDC, resolves to the same market
      let exchange: CCXTExchange;
      let instance: any;

      beforeEach(() => {
        (config.getWatch as Mock).mockReturnValue({ pairs: [{ symbol: 'BTC/USDC' }] });
        exchange = new CCXTExchange(hyperliquidConfig);
        instance = (ccxt as any).hyperliquid.mock.instances.at(-1);
        instance.market.mockReturnValue({ symbol: 'BTC/USDC', base: 'BTC', baseName: 'UBTC', quote: 'USDC' });
      });

      it.each`
        description                                                   | symbol         | balance                                 | expected
        ${'reads the asset under the base of the market'}             | ${'BTC/USDC'}  | ${{ USDC: usd, BTC: btc, HYPE: other }} | ${{ BTC: btc, USDC: usd }}
        ${'keys a pair configured with the token name by that name'}  | ${'UBTC/USDC'} | ${{ USDC: usd, BTC: btc, HYPE: other }} | ${{ UBTC: btc, USDC: usd }}
        ${'reads the asset under baseName when the base has nothing'} | ${'BTC/USDC'}  | ${{ USDC: usd, UBTC: btc }}             | ${{ BTC: btc, USDC: usd }}
        ${'reads the asset under the base when both have a balance'}  | ${'BTC/USDC'}  | ${{ USDC: usd, BTC: btc, UBTC: other }} | ${{ BTC: btc, USDC: usd }}
        ${'zeroes an asset under neither the base nor baseName'}      | ${'BTC/USDC'}  | ${{ USDC: usd, HYPE: other }}           | ${{ BTC: zero, USDC: usd }}
      `('$description', async ({ symbol, balance, expected }) => {
        (config.getWatch as Mock).mockReturnValue({ pairs: [{ symbol }] });
        instance.fetchBalance.mockResolvedValue(balance);
        expect(Object.fromEntries(await exchange.fetchBalance())).toEqual(expected);
      });

      it('does not read the balance under a baseName left unset', async () => {
        instance.market.mockReturnValue({ symbol: 'BTC/USDC', base: 'BTC', baseName: undefined, quote: 'USDC' });
        // What balance[baseName] would read if it were not checked first
        instance.fetchBalance.mockResolvedValue({ USDC: usd, undefined: other });
        expect(Object.fromEntries(await exchange.fetchBalance())).toEqual({ BTC: zero, USDC: usd });
      });
    });
  });

  describe('createLimitOrder', () => {
    const limits = { amount: { min: 0.1, max: 10 }, price: { min: 1, max: 1000 }, cost: { min: 10 } };
    let exchange: CCXTExchange;
    let instance: any;

    beforeEach(() => {
      exchange = new CCXTExchange(binanceConfig);
      instance = (ccxt as any).binance.mock.instances.at(-1);
      instance.market.mockReturnValue({ limits });
      instance.createOrder.mockResolvedValue({ id: '1', status: 'open' });
      (mapCcxtOrderToOrder as Mock).mockReturnValue({ id: '1' });
    });

    it.each`
      side
      ${'BUY'}
      ${'SELL'}
    `('creates $side limit order with validation', async ({ side }) => {
      await exchange.createLimitOrder('BTC/USDT', side, 1, 100);
      expect(instance.createOrder).toHaveBeenCalledWith('BTC/USDT', 'limit', side, 1, 100);
    });

    it('validates the order against the limits of the market', async () => {
      await exchange.createLimitOrder('BTC/USDT', 'BUY', 1, 100);
      expect(assertOrderWithinLimits).toHaveBeenCalledWith({
        tag: 'exchange',
        amount: 1,
        price: 100,
        marketData: limits,
        requested: { amount: 1, price: 100 },
      });
    });

    it('sends the amount and the price returned by the validation', async () => {
      (assertOrderWithinLimits as Mock).mockReturnValueOnce({ amount: 0.5, price: 99, cost: 49.5 });
      await exchange.createLimitOrder('BTC/USDT', 'BUY', 1, 100);
      expect(instance.createOrder).toHaveBeenCalledWith('BTC/USDT', 'limit', 'BUY', 0.5, 99);
    });

    it.each`
      amount | price  | description
      ${NaN} | ${100} | ${'a NaN amount'}
      ${0}   | ${100} | ${'a zero amount'}
      ${1}   | ${NaN} | ${'a NaN price'}
      ${20}  | ${100} | ${'an amount above the market maximum'}
    `('rejects $description with an OrderOutOfRangeError', async ({ amount, price }) => {
      await expect(exchange.createLimitOrder('BTC/USDT', 'BUY', amount, price)).rejects.toThrow(OrderOutOfRangeError);
    });

    it('does not send an order out of the market limits to the exchange', async () => {
      await exchange.createLimitOrder('BTC/USDT', 'BUY', NaN, 100).catch(() => undefined);
      expect(instance.createOrder).not.toHaveBeenCalled();
    });
  });

  describe('createMarketOrder', () => {
    const limits = { amount: { min: 0.1, max: 10 }, cost: { min: 10 } };
    let exchange: CCXTExchange;
    let instance: any;

    beforeEach(() => {
      exchange = new CCXTExchange(binanceConfig);
      instance = (ccxt as any).binance.mock.instances.at(-1);
      instance.market.mockReturnValue({ limits });
      instance.fetchTicker.mockResolvedValue({ ask: 101, bid: 100, last: 100.5 });
      instance.createOrder.mockResolvedValue({ id: '1', status: 'closed' });
      (mapCcxtOrderToOrder as Mock).mockReturnValue({ id: '1' });
    });

    // Hyperliquid refuses a market order without a price, from which ccxt derives the worst price accepted (5% slippage)
    it.each`
      side      | tickerPrice
      ${'BUY'}  | ${101}
      ${'SELL'} | ${100}
    `('creates $side market order with the ticker price $tickerPrice', async ({ side, tickerPrice }) => {
      await exchange.createMarketOrder('BTC/USDT', side, 1);
      expect(instance.createOrder).toHaveBeenCalledWith('BTC/USDT', 'market', side, 1, tickerPrice);
    });

    it.each`
      side      | tickerPrice
      ${'BUY'}  | ${101}
      ${'SELL'} | ${100}
    `('validates the $side order against the limits of the market at the ticker price $tickerPrice', async ({ side, tickerPrice }) => {
      await exchange.createMarketOrder('BTC/USDT', side, 1);
      expect(assertOrderWithinLimits).toHaveBeenCalledWith({
        tag: 'exchange',
        amount: 1,
        price: tickerPrice,
        marketData: limits,
        requested: { amount: 1, price: tickerPrice },
      });
    });

    it('sends the amount and the price returned by the validation', async () => {
      (assertOrderWithinLimits as Mock).mockReturnValueOnce({ amount: 0.5, price: 99, cost: 49.5 });
      await exchange.createMarketOrder('BTC/USDT', 'BUY', 1);
      expect(instance.createOrder).toHaveBeenCalledWith('BTC/USDT', 'market', 'BUY', 0.5, 99);
    });

    it.each`
      amount  | description
      ${NaN}  | ${'a NaN amount'}
      ${0}    | ${'a zero amount'}
      ${0.05} | ${'an amount below the market minimum'}
    `('rejects $description with an OrderOutOfRangeError', async ({ amount }) => {
      await expect(exchange.createMarketOrder('BTC/USDT', 'SELL', amount)).rejects.toThrow(OrderOutOfRangeError);
    });

    it('does not send an order out of the market limits to the exchange', async () => {
      await exchange.createMarketOrder('BTC/USDT', 'SELL', NaN).catch(() => undefined);
      expect(instance.createOrder).not.toHaveBeenCalled();
    });

    // BTCUSDT as ccxt parses it from Binance: LOT_SIZE (amount) up to 9000 BTC and MARKET_LOT_SIZE (market) up to 86.27382215 BTC,
    // both applied by Binance to a market order. It used to be sent between the two maxima, to be refused by Binance (-1013 "Filter
    // failure: MARKET_LOT_SIZE", which ccxt reports as "order amount should be evenly divisible by lot size").
    describe('on a market whose market orders have a lower maximum amount', () => {
      const binanceLimits = {
        amount: { min: 0.00001, max: 9000 },
        price: { min: 0.01, max: 1000000 },
        cost: { min: 5, max: 9000000 },
        market: { min: 0, max: 86.27382215 },
      };

      beforeEach(() => {
        instance.market.mockReturnValue({ limits: binanceLimits });
      });

      it('rejects a market order above that maximum with an OrderOutOfRangeError naming the narrowed range', async () => {
        await expect(exchange.createMarketOrder('BTC/USDT', 'SELL', 100)).rejects.toStrictEqual(
          new OrderOutOfRangeError('exchange', 'amount', 100, 0.00001, 86.27382215),
        );
      });

      it('does not send a market order above that maximum to the exchange', async () => {
        await exchange.createMarketOrder('BTC/USDT', 'SELL', 100).catch(() => undefined);
        expect(instance.createOrder).not.toHaveBeenCalled();
      });

      it('sends a market order within that maximum', async () => {
        await exchange.createMarketOrder('BTC/USDT', 'SELL', 80);
        expect(instance.createOrder).toHaveBeenCalledWith('BTC/USDT', 'market', 'SELL', 80, 100);
      });

      it('sends a limit order of the amount refused to a market order, the maximum not applying to it', async () => {
        await exchange.createLimitOrder('BTC/USDT', 'SELL', 100, 100);
        expect(instance.createOrder).toHaveBeenCalledWith('BTC/USDT', 'limit', 'SELL', 100, 100);
      });
    });

    it('rejects an order whose ticker failed with a value that is not an Error with a GekkoError carrying that value', async () => {
      instance.fetchTicker.mockRejectedValue('socket hang up');
      await expect(exchange.createMarketOrder('BTC/USDT', 'BUY', 1)).rejects.toThrow(
        '[EXCHANGE] Market order not sent: ticker unavailable (socket hang up)',
      );
    });

    // fetchTicker throws a GekkoError, tagged as well, for a ticker without a last price
    it('rejects an order whose ticker has no last price with a GekkoError carrying its message without its tag', async () => {
      instance.fetchTicker.mockResolvedValue({ ask: null, bid: null, last: null });
      await expect(exchange.createMarketOrder('BTC/USDT', 'BUY', 1)).rejects.toThrow(
        '[EXCHANGE] Market order not sent: ticker unavailable (Fetch ticker failed to return data for BTC/USDT)',
      );
    });

    // Quoted whole: the regular expression that cut the tag off a GekkoError cut a word in brackets off any other message too, and
    // String() threw for a value without a prototype, rejecting the order with a TypeError
    it.each`
      failure                                        | rejection                                              | quoted
      ${'an Error starting with a word in brackets'} | ${new Error('[503] Service Unavailable')}              | ${'[503] Service Unavailable'}
      ${'a value without a prototype'}               | ${Object.assign(Object.create(null), { status: 503 })} | ${'[Object: null prototype] { status: 503 }'}
    `('rejects an order whose ticker failed with $failure with a GekkoError quoting it: $quoted', async ({ rejection, quoted }) => {
      instance.fetchTicker.mockRejectedValue(rejection);
      await expect(exchange.createMarketOrder('BTC/USDT', 'BUY', 1)).rejects.toThrow(
        `[EXCHANGE] Market order not sent: ticker unavailable (${quoted})`,
      );
    });
  });

  // The price of a limit order is the one given, that of a market order the ask of the ticker for a BUY
  const createLimitBuy = (exchange: CCXTExchange, _instance: any, amount: number, price: number) =>
    exchange.createLimitOrder('BTC/USDT', 'BUY', amount, price);
  const createMarketBuy = (exchange: CCXTExchange, instance: any, amount: number, price: number) => {
    instance.fetchTicker.mockResolvedValue({ ask: price, bid: price, last: price });
    return exchange.createMarketOrder('BTC/USDT', 'BUY', amount);
  };
  // What ccxt's base Exchange, which Binance uses, throws for a price rounded to 0
  const refusePriceRoundedToZero = () => {
    throw new ccxt.InvalidOrder('binance price of BTC/USDT must be greater than minimum price precision of 0.01');
  };

  describe.each`
    method                 | type        | create
    ${'createLimitOrder'}  | ${'limit'}  | ${createLimitBuy}
    ${'createMarketOrder'} | ${'market'} | ${createMarketBuy}
  `('$method, the precision of the market', ({ type, create }) => {
    // BTC/USDT on Binance: a lot step of 0.00001 BTC, a tick of 0.01 USDT and a minimum notional of 5 USDT
    const limits = { amount: { min: 0.00001, max: 9000 }, price: { min: 0.01, max: 1000000 }, cost: { min: 5 } };
    const precision = { amount: 0.00001, price: 0.01 };
    let exchange: CCXTExchange;
    let instance: any;

    beforeEach(() => {
      exchange = new CCXTExchange(binanceConfig);
      instance = (ccxt as any).binance.mock.instances.at(-1);
      instance.market.mockReturnValue({ limits, precision });
      // The price rounded to the tick, as ccxt rounds it for Binance; the amount is truncated by ccxt's own decimalToPrecision
      instance.priceToPrecision.mockImplementation((_symbol: string, price: number) => price.toFixed(2));
      instance.createOrder.mockResolvedValue({ id: '1', status: 'open' });
      (mapCcxtOrderToOrder as Mock).mockReturnValue({ id: '1' });
    });

    // 0.0000560556 BTC at 99990 USDT cost 5.605 USDT, but ccxt sends 0.00005 BTC: 4.9995 USDT, which Binance refuses (-1013)
    it('rejects an order under the minimum cost once its amount is truncated with an OrderOutOfRangeError', async () => {
      await expect(create(exchange, instance, 0.0000560556, 99990)).rejects.toThrow(OrderOutOfRangeError);
    });

    it('does not send to the exchange an order under the minimum cost once its amount is truncated', async () => {
      await create(exchange, instance, 0.0000560556, 99990).catch(() => undefined);
      expect(instance.createOrder).not.toHaveBeenCalled();
    });

    it('validates the amount and the price rounded to the precision of the market, given those asked for', async () => {
      await create(exchange, instance, 1.234567, 100.456);
      expect(assertOrderWithinLimits).toHaveBeenCalledWith({
        tag: 'exchange',
        amount: 1.23456,
        price: 100.46,
        marketData: { ...limits, precision },
        requested: { amount: 1.234567, price: 100.456 },
      });
    });

    it('sends the amount and the price rounded to the precision of the market', async () => {
      await create(exchange, instance, 1.234567, 100.456);
      expect(instance.createOrder).toHaveBeenCalledWith('BTC/USDT', type, 'BUY', 1.23456, 100.46);
    });

    // ccxt would throw a plain Error for a NaN price, where the validation refuses it with its own message
    it.each`
      description             | amount      | price  | rounding
      ${'a NaN amount'}       | ${NaN}      | ${100} | ${'decimalToPrecision'}
      ${'an infinite amount'} | ${Infinity} | ${100} | ${'decimalToPrecision'}
      ${'a zero amount'}      | ${0}        | ${100} | ${'decimalToPrecision'}
      ${'a negative amount'}  | ${-1}       | ${100} | ${'decimalToPrecision'}
      ${'a NaN price'}        | ${1}        | ${NaN} | ${'priceToPrecision'}
      ${'a zero price'}       | ${1}        | ${0}   | ${'priceToPrecision'}
    `('leaves $description to the validation without rounding it', async ({ amount, price, rounding }) => {
      await create(exchange, instance, amount, price).catch(() => undefined);
      expect(instance[rounding]).not.toHaveBeenCalled();
    });

    // Hyperliquid's amountToPrecision rounds half up: an all-in order on a balance of 0.000059958 BTC would be sent as 0.00006
    it('sends the amount truncated to the step of the market to hyperliquid', async () => {
      exchange = new CCXTExchange(hyperliquidConfig);
      instance = (ccxt as any).hyperliquid.mock.instances.at(-1);
      await create(exchange, instance, 0.000059958, 120000);
      expect(instance.createOrder).toHaveBeenCalledWith('BTC/USDT', type, 'BUY', 0.00005, 120000);
    });

    it('does not round the amount with the amountToPrecision of the exchange', async () => {
      await create(exchange, instance, 0.000059958, 120000);
      expect(instance.amountToPrecision).not.toHaveBeenCalled();
    });

    // Reported as 0, the amount asked for, the step and the minimum all unsaid: "Order 'amount' with value 0 is invalid"
    it('refuses an amount truncated to nothing with an OrderOutOfRangeError naming the amount asked for and the step', async () => {
      await expect(create(exchange, instance, 0.000004, 100)).rejects.toStrictEqual(
        new OrderOutOfRangeError('exchange', 'amount', 0, 0.00001, 9000, { requested: 0.000004, step: 0.00001 }),
      );
    });

    it.each`
      description                                             | rounding
      ${'throws an InvalidOrder for, as it does for Binance'} | ${refusePriceRoundedToZero}
      ${'rounds to 0, as it does for Hyperliquid'}            | ${() => '0'}
    `('refuses a price ccxt $description with an OrderOutOfRangeError naming the price asked for and the step', async ({ rounding }) => {
      instance.priceToPrecision.mockImplementation(rounding);
      await expect(create(exchange, instance, 1, 0.004)).rejects.toStrictEqual(
        new OrderOutOfRangeError('exchange', 'price', 0, 0.01, 1000000, { requested: 0.004, step: 0.01 }),
      );
    });

    it('rejects with any other failure of the rounding', async () => {
      const failure = new Error('numPrecisionDigits has an invalid number');
      instance.decimalToPrecision.mockImplementation(() => {
        throw failure;
      });
      await expect(create(exchange, instance, 1, 100)).rejects.toBe(failure);
    });

    // As Binance's createOrder does, where ccxt's rounding would throw
    it.each`
      description | marketPrecision        | amount      | price
      ${'amount'} | ${{ price: 0.01 }}     | ${1.234567} | ${100.46}
      ${'price'}  | ${{ amount: 0.00001 }} | ${1.23456}  | ${100.456}
    `('sends the $description of a market without precision for it as it is', async ({ marketPrecision, amount, price }) => {
      instance.market.mockReturnValue({ limits, precision: marketPrecision });
      await create(exchange, instance, 1.234567, 100.456);
      expect(instance.createOrder).toHaveBeenCalledWith('BTC/USDT', type, 'BUY', amount, price);
    });
  });

  // Hyperliquid takes 5 significant digits in a price, whole units from 10000 on. ccxt sets precision.price once, when the markets load,
  // to the tick at the price of that moment: 0.1 on a market loaded at 9990, finer than the tick from 10000 on, where ccxt sends 10000.3
  // and 10000.4 at 10000. The roundings mocked are those of ccxt 4.5.39 (see the hyperliquid order prices of exchange.utils.test.ts).
  describe('createLimitOrder, a price rounded beyond the tick of the market data', () => {
    const limits = { amount: { min: 0.01 }, cost: { min: 10 } };
    let exchange: CCXTExchange;
    let instance: any;

    beforeEach(() => {
      exchange = new CCXTExchange(hyperliquidConfig);
      instance = (ccxt as any).hyperliquid.mock.instances.at(-1);
      instance.market.mockReturnValue({ limits, precision: { amount: 0.01, price: 0.1 } });
      instance.priceToPrecision.mockReturnValue('10000');
      instance.createOrder.mockResolvedValue({ id: '1', status: 'open' });
      (mapCcxtOrderToOrder as Mock).mockReturnValue({ id: '1' });
    });

    it('warns of the price sent, naming the significant digits hyperliquid takes', async () => {
      await exchange.createLimitOrder('BTC/USDC', 'SELL', 1, 10000.4);
      expect(logger.warning).toHaveBeenCalledWith(
        'exchange',
        'LIMIT SELL order on BTC/USDC at 10000.4 sent to hyperliquid at 10000, more than half a tick of precision.price (0.1) away: hyperliquid takes 5 significant digits in a price (precision.priceSignificantDigits), a tick coarser than precision.price at that price',
      );
    });

    it('sends the order at the rounded price all the same', async () => {
      await exchange.createLimitOrder('BTC/USDC', 'SELL', 1, 10000.4);
      expect(instance.createOrder).toHaveBeenCalledWith('BTC/USDC', 'limit', 'SELL', 1, 10000);
    });

    // A price under 1e-6 on a tick of 1e-9, which String wrote 4.5678e-7 and 1e-9
    it('writes the prices and the tick of the warning with every digit, without an exponent', async () => {
      instance.market.mockReturnValue({ limits, precision: { amount: 0.01, price: 1e-9 } });
      instance.priceToPrecision.mockReturnValue('0.00000046');
      await exchange.createLimitOrder('BTC/USDC', 'BUY', 100_000_000, 4.5678e-7);
      expect(logger.warning).toHaveBeenCalledWith(
        'exchange',
        'LIMIT BUY order on BTC/USDC at 0.00000045678 sent to hyperliquid at 0.00000046, more than half a tick of precision.price (0.000000001) away: hyperliquid takes 5 significant digits in a price (precision.priceSignificantDigits), a tick coarser than precision.price at that price',
      );
    });

    // A rounding Binance does not make, its tick being precision.price: the warning then names no rule
    it('warns without naming significant digits on an exchange that states none', async () => {
      exchange = new CCXTExchange(binanceConfig);
      await exchange.createLimitOrder('BTC/USDC', 'SELL', 1, 10000.4);
      expect(logger.warning).toHaveBeenCalledWith(
        'exchange',
        'LIMIT SELL order on BTC/USDC at 10000.4 sent to binance at 10000, more than half a tick of precision.price (0.1) away',
      );
    });

    it.each`
      description                                    | price       | sent
      ${'less than a tick away, more than half one'} | ${10000.08} | ${'10000'}
      ${'rounded up'}                                | ${10000.6}  | ${'10001'}
    `('warns of a price sent $description', async ({ price, sent }) => {
      instance.priceToPrecision.mockReturnValue(sent);
      await exchange.createLimitOrder('BTC/USDC', 'BUY', 1, price);
      expect(logger.warning).toHaveBeenCalledOnce();
    });

    // 100 - 99.9995 is 0.0005000000000023874 in binary: subtracted so, a move of half a tick of 0.001 would be one beyond it
    it.each`
      description                                           | tick     | price      | sent
      ${'of 5 significant digits, sent as it is'}           | ${0.1}   | ${10001}   | ${'10001'}
      ${'half a tick away, a tie rounded up'}               | ${0.1}   | ${9999.95} | ${'10000'}
      ${'half a tick away, more than half of it in binary'} | ${0.001} | ${99.9995} | ${'100'}
      ${'less than half a tick away'}                       | ${0.1}   | ${9999.94} | ${'9999.9'}
    `('does not warn of a price $description', async ({ tick, price, sent }) => {
      instance.market.mockReturnValue({ limits, precision: { amount: 0.01, price: tick } });
      instance.priceToPrecision.mockReturnValue(sent);
      await exchange.createLimitOrder('BTC/USDC', 'BUY', 1, price);
      expect(logger.warning).not.toHaveBeenCalled();
    });

    it('does not warn of an order refused for its amount', async () => {
      await exchange.createLimitOrder('BTC/USDC', 'SELL', 0.001, 10000.4).catch(() => undefined);
      expect(logger.warning).not.toHaveBeenCalled();
    });

    it('does not warn on a market whose price tick is 0, which bounds nothing', async () => {
      instance.market.mockReturnValue({ limits, precision: { amount: 0.01, price: 0 } });
      await exchange.createLimitOrder('BTC/USDC', 'SELL', 1, 10000.4);
      expect(logger.warning).not.toHaveBeenCalled();
    });

    it('does not warn of the price of a market order, the ticker price', async () => {
      instance.fetchTicker.mockResolvedValue({ ask: 10000.4, bid: 10000.4, last: 10000.4 });
      await exchange.createMarketOrder('BTC/USDC', 'BUY', 1);
      expect(logger.warning).not.toHaveBeenCalled();
    });
  });

  describe('cancelOrder', () => {
    // What ccxt 4.5.39 returns for the answer of Hyperliquid to a cancelation, { status: 'ok', response: { type: 'cancel', data:
    // { statuses: ['success'] } } }: an order built from the status alone, with neither id nor fill (hyperliquid.js cancelOrders)
    const hyperliquidAcknowledgement = { info: 'success', status: 'success', id: undefined, filled: undefined, remaining: undefined };
    // What fetchOrder parses from Hyperliquid for that order afterwards: canceled after a partial fill
    const orderReadBack = { id: '6195281425', status: 'canceled', amount: 1, filled: 0.4, remaining: 0.6, timestamp: 1704346468838 };
    let exchange: CCXTExchange;
    let instance: any;

    beforeEach(() => {
      (mapCcxtOrderToOrder as Mock).mockImplementation(({ id, status, filled, remaining }) => ({ id, status, filled, remaining }));
    });

    describe('on binance, answered with the order canceled', () => {
      // What ccxt parses from the answer of Binance to DELETE /api/v3/order: the order itself, with its status and its fill
      const answer = { id: '1', status: 'canceled', amount: 1, filled: 0.4, remaining: 0.6, timestamp: 1704346468838 };

      beforeEach(() => {
        exchange = new CCXTExchange(binanceConfig);
        instance = (ccxt as any).binance.mock.instances.at(-1);
        instance.cancelOrder.mockResolvedValue(answer);
      });

      it('sends the cancelation of the order by its id', async () => {
        await exchange.cancelOrder('BTC/USDT', '1');
        expect(instance.cancelOrder).toHaveBeenCalledWith('1', 'BTC/USDT');
      });

      it('does not read the order back', async () => {
        await exchange.cancelOrder('BTC/USDT', '1');
        expect(instance.fetchOrder).not.toHaveBeenCalled();
      });

      it('returns the state of the answer', async () => {
        expect(await exchange.cancelOrder('BTC/USDT', '1')).toEqual({ id: '1', status: 'canceled', filled: 0.4, remaining: 0.6 });
      });
    });

    describe.each`
      description                                 | answer
      ${'the acknowledgement of Hyperliquid'}     | ${hyperliquidAcknowledgement}
      ${'the id of the order without its status'} | ${{ id: '6195281425', status: undefined, filled: 0.4 }}
      ${'the status of the order without its id'} | ${{ id: undefined, status: 'canceled', filled: 0.4 }}
      ${'no order at all'}                        | ${undefined}
    `('answered with $description', ({ answer }) => {
      beforeEach(() => {
        exchange = new CCXTExchange(hyperliquidConfig);
        instance = (ccxt as any).hyperliquid.mock.instances.at(-1);
        instance.cancelOrder.mockResolvedValue(answer);
        instance.fetchOrder.mockResolvedValue(orderReadBack);
      });

      it('reads the order back by the id the cancelation was sent for', async () => {
        await exchange.cancelOrder('BTC/USDC', '6195281425');
        expect(instance.fetchOrder).toHaveBeenCalledWith('6195281425', 'BTC/USDC');
      });

      it('returns the state of the order read back', async () => {
        expect(await exchange.cancelOrder('BTC/USDC', '6195281425')).toEqual({
          id: '6195281425',
          status: 'canceled',
          filled: 0.4,
          remaining: 0.6,
        });
      });
    });

    describe('answered with the acknowledgement of Hyperliquid, read back with a timeout on every attempt', () => {
      beforeEach(() => {
        exchange = new CCXTExchange(hyperliquidConfig);
        instance = (ccxt as any).hyperliquid.mock.instances.at(-1);
        instance.cancelOrder.mockResolvedValue(hyperliquidAcknowledgement);
        instance.fetchOrder.mockRejectedValue(
          new ccxt.RequestTimeout('hyperliquid POST https://api.hyperliquid.xyz/info request timed out'),
        );
      });

      it('has sent the cancelation to the exchange only once', async () => {
        await exchange.cancelOrder('BTC/USDC', '6195281425').catch(() => undefined);
        expect(instance.cancelOrder).toHaveBeenCalledOnce();
      });

      it('logs that the cancelation of the order was accepted', async () => {
        await exchange.cancelOrder('BTC/USDC', '6195281425').catch(() => undefined);
        expect(logger.error).toHaveBeenCalledWith('exchange', expect.stringContaining('accepted the cancelation of order 6195281425'));
      });

      it('rejects with the error of the read', async () => {
        await expect(exchange.cancelOrder('BTC/USDC', '6195281425')).rejects.toBeInstanceOf(ExchangeNetworkError);
      });
    });
  });

  describe.each`
    method                 | call
    ${'createLimitOrder'}  | ${(e: CCXTExchange) => e.createLimitOrder('BTC/USDT', 'BUY', 1, 100)}
    ${'createMarketOrder'} | ${(e: CCXTExchange) => e.createMarketOrder('BTC/USDT', 'BUY', 1)}
  `('$method, the state of the order created', ({ call }) => {
    const limits = { amount: { min: 0.1, max: 10 }, price: { min: 1, max: 1000 }, cost: { min: 10 } };
    // What ccxt parses from the answer of Hyperliquid to the creation of an order executed at once,
    // { filled: { totalSz: '1', avgPx: '100.5', oid: 6195281425 } }: an id, but neither a status nor a timestamp
    const answerWithoutStatus = { id: '6195281425', amount: 1, filled: 1, average: 100.5, status: undefined, timestamp: undefined };
    const orderReadBack = { id: '6195281425', amount: 1, filled: 1, remaining: 0, status: 'closed', timestamp: 1704346468838 };
    let exchange: CCXTExchange;
    let instance: any;

    beforeEach(() => {
      exchange = new CCXTExchange(hyperliquidConfig);
      instance = (ccxt as any).hyperliquid.mock.instances.at(-1);
      instance.market.mockReturnValue({ limits });
      instance.fetchTicker.mockResolvedValue({ ask: 101, bid: 100, last: 100.5 });
      instance.fetchOrder.mockResolvedValue(orderReadBack);
      (mapCcxtOrderToOrder as Mock).mockImplementation(({ id, status }) => ({ id, status }));
    });

    describe('answered with the status of the order', () => {
      beforeEach(() => {
        instance.createOrder.mockResolvedValue({ id: '6195281425', status: 'open', timestamp: 1704346468838 });
      });

      it('does not read the order back', async () => {
        await call(exchange);
        expect(instance.fetchOrder).not.toHaveBeenCalled();
      });

      it('returns the state of the answer', async () => {
        expect(await call(exchange)).toEqual({ id: '6195281425', status: 'open' });
      });
    });

    describe('answered without the status of the order', () => {
      beforeEach(() => {
        instance.createOrder.mockResolvedValue(answerWithoutStatus);
      });

      it('reads the order back by its id', async () => {
        await call(exchange);
        expect(instance.fetchOrder).toHaveBeenCalledWith('6195281425', 'BTC/USDT');
      });

      it('returns the state of the order read back', async () => {
        expect(await call(exchange)).toEqual({ id: '6195281425', status: 'closed' });
      });
    });

    // The order exists on the exchange: whatever the read failed with, the outcome of the creation is what the orders hear of. The
    // read's own failure used to reach them: an InvalidOrder made the order created a refusal, any other one an error that placed
    // nothing, and a strategy placed the order again beside it
    describe.each`
      description                                     | readFailure                                                                                       | readMessage
      ${'a timeout on every attempt'}                 | ${new ccxt.RequestTimeout('hyperliquid POST https://api.hyperliquid.xyz/info request timed out')} | ${'hyperliquid POST https://api.hyperliquid.xyz/info request timed out'}
      ${'a bad request (an InvalidOrder of Gekko)'}   | ${new ccxt.BadRequest('hyperliquid {"status":"err","response":"Invalid oid"}')}                   | ${'hyperliquid {"status":"err","response":"Invalid oid"}'}
      ${'an order unknown (the read lagging behind)'} | ${new ccxt.OrderNotFound('hyperliquid order 6195281425 not found')}                               | ${'hyperliquid order 6195281425 not found'}
    `('answered without the status of the order, read back with $description', ({ readFailure, readMessage }) => {
      beforeEach(() => {
        instance.createOrder.mockResolvedValue(answerWithoutStatus);
        instance.fetchOrder.mockRejectedValue(readFailure);
      });

      it('has sent the creation to the exchange only once', async () => {
        await call(exchange).catch(() => undefined);
        expect(instance.createOrder).toHaveBeenCalledOnce();
      });

      it('logs the id of the order created', async () => {
        await call(exchange).catch(() => undefined);
        expect(logger.error).toHaveBeenCalledWith('exchange', expect.stringContaining('6195281425'));
      });

      it('rejects with an OrderOutcomeUnknown: the order may be live', async () => {
        await expect(call(exchange)).rejects.toBeInstanceOf(OrderOutcomeUnknown);
      });

      it('says which order was created, and why its state is unknown', async () => {
        await expect(call(exchange)).rejects.toThrow(
          `[EXCHANGE] Order 6195281425 was created on hyperliquid for BTC/USDT, but its state could not be read back: ${readMessage}`,
        );
      });

      it('keeps the failure of the read as the cause', async () => {
        const failure = await call(exchange).catch((err: unknown) => err);
        expect((failure as Error).cause).toBeInstanceOf(GekkoError);
      });
    });

    // String() threw for it: the creation rejected with a TypeError, which the orders took for a failure that placed nothing
    it('rejects a creation whose read-back failed with a value without a prototype with an OrderOutcomeUnknown quoting it', async () => {
      instance.createOrder.mockResolvedValue(answerWithoutStatus);
      instance.fetchOrder.mockRejectedValue(Object.assign(Object.create(null), { status: 503 }));
      await expect(call(exchange)).rejects.toThrow(
        new OrderOutcomeUnknown(
          'Order 6195281425 was created on hyperliquid for BTC/USDT, but its state could not be read back: [Object: null prototype] { status: 503 }',
        ),
      );
    });

    it.each`
      description                                   | answer
      ${'an order with neither a status nor an id'} | ${{ info: { status: 'ok' } }}
      ${'no order at all'}                          | ${undefined}
    `('rejects a creation answered with $description with an OrderOutcomeUnknown: the order may be live', async ({ answer }) => {
      instance.createOrder.mockResolvedValue(answer);
      await expect(call(exchange)).rejects.toBeInstanceOf(OrderOutcomeUnknown);
    });
  });

  describe('ccxt errors', () => {
    const limits = { amount: { min: 0.1, max: 10 }, price: { min: 1, max: 1000 }, cost: { min: 10 } };
    let exchange: CCXTExchange;
    let instance: any;

    beforeEach(() => {
      exchange = new CCXTExchange(binanceConfig);
      instance = (ccxt as any).binance.mock.instances.at(-1);
      instance.market.mockReturnValue({ limits, base: 'BTC', quote: 'USDT' });
      instance.fetchTicker.mockResolvedValue({ ask: 101, bid: 100, last: 100.5 });
    });

    it('rejects the cancelation of an order unknown to the exchange with the OrderNotFound of Gekko', async () => {
      instance.cancelOrder.mockRejectedValue(new ccxt.OrderNotFound('binance {"code":-2011,"msg":"Unknown order sent."}'));
      await expect(exchange.cancelOrder('BTC/USDT', '1')).rejects.toBeInstanceOf(OrderNotFound);
    });

    it('rejects a limit order refused for insufficient funds with the InvalidOrder of Gekko', async () => {
      instance.createOrder.mockRejectedValue(new ccxt.InsufficientFunds('binance Account has insufficient balance for requested action.'));
      await expect(exchange.createLimitOrder('BTC/USDT', 'BUY', 1, 100)).rejects.toBeInstanceOf(InvalidOrder);
    });

    it.each`
      method                 | clientMethod         | call
      ${'fetchTickers'}      | ${'fetchTickers'}    | ${(e: CCXTExchange) => e.fetchTickers(['BTC/USDT'])}
      ${'fetchTicker'}       | ${'fetchTicker'}     | ${(e: CCXTExchange) => e.fetchTicker('BTC/USDT')}
      ${'fetchOHLCV'}        | ${'fetchOHLCV'}      | ${(e: CCXTExchange) => e.fetchOHLCV('BTC/USDT')}
      ${'fetchMyTrades'}     | ${'fetchMyTrades'}   | ${(e: CCXTExchange) => e.fetchMyTrades('BTC/USDT')}
      ${'fetchOrder'}        | ${'fetchOrder'}      | ${(e: CCXTExchange) => e.fetchOrder('BTC/USDT', '1')}
      ${'fetchOpenOrders'}   | ${'fetchOpenOrders'} | ${(e: CCXTExchange) => e.fetchOpenOrders('BTC/USDT')}
      ${'fetchBalance'}      | ${'fetchBalance'}    | ${(e: CCXTExchange) => e.fetchBalance()}
      ${'createLimitOrder'}  | ${'createOrder'}     | ${(e: CCXTExchange) => e.createLimitOrder('BTC/USDT', 'BUY', 1, 100)}
      ${'createMarketOrder'} | ${'createOrder'}     | ${(e: CCXTExchange) => e.createMarketOrder('BTC/USDT', 'BUY', 1)}
      ${'cancelOrder'}       | ${'cancelOrder'}     | ${(e: CCXTExchange) => e.cancelOrder('BTC/USDT', '1')}
    `('$method rejects with the error of Gekko translated from the ccxt one', async ({ clientMethod, call }) => {
      instance[clientMethod].mockRejectedValue(new ccxt.BadSymbol('binance {"code":-1121,"msg":"Invalid symbol."}'));
      await expect(call(exchange)).rejects.toBeInstanceOf(InvalidOrder);
    });
  });

  // What ccxt 4.5.39 throws for Binance's -1006, an internal error whose outcome Binance says is unknown: an OperationFailed, which is
  // not a NetworkError. Left as it was, it ended the order as one that placed nothing, and a strategy placed the order again.
  const unexpectedResponse = new ccxt.OperationFailed(
    'binance {"code":-1006,"msg":"An unexpected response was received from the message bus. Execution status unknown."}',
  );

  describe.each`
    method                 | call
    ${'createLimitOrder'}  | ${(e: CCXTExchange) => e.createLimitOrder('BTC/USDT', 'BUY', 1, 100)}
    ${'createMarketOrder'} | ${(e: CCXTExchange) => e.createMarketOrder('BTC/USDT', 'BUY', 1)}
  `('$method, a creation the exchange fails without refusing the order', ({ call }) => {
    const limits = { amount: { min: 0.1, max: 10 }, price: { min: 1, max: 1000 }, cost: { min: 10 } };
    let exchange: CCXTExchange;
    let instance: any;

    beforeEach(() => {
      exchange = new CCXTExchange(binanceConfig);
      instance = (ccxt as any).binance.mock.instances.at(-1);
      instance.market.mockReturnValue({ limits });
      instance.fetchTicker.mockResolvedValue({ ask: 101, bid: 100, last: 100.5 });
    });

    describe.each`
      description                                                   | failure
      ${'an internal error of Binance (-1006, an OperationFailed)'} | ${unexpectedResponse}
      ${'an answer ccxt could not read (a BadResponse)'}            | ${new ccxt.BadResponse('could not parse the response into json')}
    `('with $description', ({ failure }) => {
      beforeEach(() => {
        instance.createOrder.mockRejectedValue(failure);
      });

      it('has sent the creation to the exchange only once', async () => {
        await call(exchange).catch(() => undefined);
        expect(instance.createOrder).toHaveBeenCalledOnce();
      });

      it('rejects with an OrderOutcomeUnknown: the order may be live', async () => {
        await expect(call(exchange)).rejects.toBeInstanceOf(OrderOutcomeUnknown);
      });

      it('says that the failure is not a refusal, with the message of ccxt', async () => {
        await expect(call(exchange)).rejects.toThrow(
          `[EXCHANGE] binance answered the creation of an order on BTC/USDT with a failure that is not a refusal: ${failure.message}`,
        );
      });

      it('keeps the ccxt error as the cause', async () => {
        await expect(call(exchange)).rejects.toHaveProperty('cause', failure);
      });
    });

    // A NetworkError keeps its own translation (see 'network errors'), and so do a refusal and any other ccxt error
    const timeout = new ccxt.RequestTimeout('binance POST https://api.binance.com/api/v3/order request timed out (10000 ms)');
    const rateLimit = new ccxt.RateLimitExceeded('binance {"code":-1003,"msg":"Too many requests queued."}');
    const refusal = new ccxt.InsufficientFunds('binance Account has insufficient balance for requested action.');
    const keyRefused = new ccxt.AuthenticationError('binance {"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}');
    it.each`
      description                                       | failure       | expected
      ${'a timeout, a NetworkError'}                    | ${timeout}    | ${ExchangeNetworkError}
      ${'a rate limit (-1003), a NetworkError'}         | ${rateLimit}  | ${ExchangeNetworkError}
      ${'a refusal (-2010), an InsufficientFunds'}      | ${refusal}    | ${InvalidOrder}
      ${'an API key refused (-2015), an ExchangeError'} | ${keyRefused} | ${ccxt.AuthenticationError}
    `('rejects a creation failed with $description as before, not with an OrderOutcomeUnknown', async ({ failure, expected }) => {
      instance.createOrder.mockRejectedValue(failure);
      await expect(call(exchange)).rejects.toBeInstanceOf(expected);
    });
  });

  // Nothing was sent: the ticker of a market order failed before its creation
  it('rejects a market order whose ticker failed with an internal error of Binance as not sent, not as an outcome unknown', async () => {
    const exchange = new CCXTExchange(binanceConfig);
    const instance = (ccxt as any).binance.mock.instances.at(-1);
    instance.market.mockReturnValue({ limits: { amount: { min: 0.1, max: 10 }, cost: { min: 10 } } });
    instance.fetchTicker.mockRejectedValue(unexpectedResponse);
    await expect(exchange.createMarketOrder('BTC/USDT', 'BUY', 1)).rejects.toThrow(
      `[EXCHANGE] Market order not sent: ticker unavailable (${unexpectedResponse.message})`,
    );
  });

  // A cancelation that fails so is not a creation: the order layer tells whether the order is still open (see Order.orderErrored)
  it('rejects a cancelation failed with an internal error of Binance with that error, not an OrderOutcomeUnknown', async () => {
    const exchange = new CCXTExchange(binanceConfig);
    const instance = (ccxt as any).binance.mock.instances.at(-1);
    instance.cancelOrder.mockRejectedValue(unexpectedResponse);
    await expect(exchange.cancelOrder('BTC/USDT', '1')).rejects.toBe(unexpectedResponse);
  });

  describe('network errors', () => {
    const limits = { amount: { min: 0.1, max: 10 }, price: { min: 1, max: 1000 }, cost: { min: 10 } };
    // A NetworkError: the exchange may have executed the request, only its response is lost
    const timeout = new ccxt.RequestTimeout('binance POST https://api.binance.com/api/v3/order request timed out (10000 ms)');
    // What the exchange answers a write sent again after it executed the first one: a second order (ccxt gives it a new client
    // order id) is refused for lack of funds, the first one holding them, and a second cancelation finds no order to cancel
    const insufficientFunds = new ccxt.InsufficientFunds(
      'binance {"code":-2010,"msg":"Account has insufficient balance for requested action."}',
    );
    const unknownOrder = new ccxt.OrderNotFound('binance {"code":-2011,"msg":"Unknown order sent."}');
    let exchange: CCXTExchange;
    let instance: any;

    beforeEach(() => {
      exchange = new CCXTExchange(binanceConfig);
      instance = (ccxt as any).binance.mock.instances.at(-1);
      instance.market.mockReturnValue({ limits });
      instance.fetchTicker.mockResolvedValue({ ask: 101, bid: 100, last: 100.5 });
      instance.fetchOrder.mockRejectedValue(timeout);
    });

    describe.each`
      method                 | clientMethod     | replayError          | call
      ${'createLimitOrder'}  | ${'createOrder'} | ${insufficientFunds} | ${(e: CCXTExchange) => e.createLimitOrder('BTC/USDT', 'BUY', 1, 100)}
      ${'createMarketOrder'} | ${'createOrder'} | ${insufficientFunds} | ${(e: CCXTExchange) => e.createMarketOrder('BTC/USDT', 'BUY', 1)}
      ${'cancelOrder'}       | ${'cancelOrder'} | ${unknownOrder}      | ${(e: CCXTExchange) => e.cancelOrder('BTC/USDT', '1')}
    `('$method, a write executed by the exchange whose response timed out', ({ clientMethod, replayError, call }) => {
      beforeEach(() => {
        instance[clientMethod].mockRejectedValueOnce(timeout).mockRejectedValue(replayError);
      });

      it('has sent the request to the exchange only once', async () => {
        await call(exchange).catch(() => undefined);
        expect(instance[clientMethod]).toHaveBeenCalledOnce();
      });

      it('rejects with an ExchangeNetworkError', async () => {
        await expect(call(exchange)).rejects.toBeInstanceOf(ExchangeNetworkError);
      });

      it('rejects with the ccxt error as the cause', async () => {
        await expect(call(exchange)).rejects.toHaveProperty('cause', timeout);
      });
    });

    it.each`
      method               | call
      ${'fetchOrder'}      | ${(e: CCXTExchange) => e.fetchOrder('BTC/USDT', '1')}
      ${'fetchOpenOrders'} | ${(e: CCXTExchange) => e.fetchOpenOrders('BTC/USDT')}
    `('sends a read ($method) again after a timeout, up to BROKER_MAX_RETRIES_ON_FAILURE times', async ({ method, call }) => {
      instance[method].mockRejectedValue(timeout);
      await call(exchange).catch(() => undefined);
      expect(instance[method]).toHaveBeenCalledTimes(BROKER_MAX_RETRIES_ON_FAILURE + 1);
    });

    it('rejects a read of the open orders timing out on every attempt with an ExchangeNetworkError', async () => {
      instance.fetchOpenOrders.mockRejectedValue(timeout);
      await expect(exchange.fetchOpenOrders('BTC/USDT')).rejects.toBeInstanceOf(ExchangeNetworkError);
    });

    describe('createMarketOrder with a ticker timing out on every attempt', () => {
      beforeEach(() => {
        instance.fetchTicker.mockRejectedValue(timeout);
      });

      it('fetches the ticker in a single series of attempts', async () => {
        await exchange.createMarketOrder('BTC/USDT', 'BUY', 1).catch(() => undefined);
        expect(instance.fetchTicker).toHaveBeenCalledTimes(BROKER_MAX_RETRIES_ON_FAILURE + 1);
      });

      it('sends no order to the exchange', async () => {
        await exchange.createMarketOrder('BTC/USDT', 'BUY', 1).catch(() => undefined);
        expect(instance.createOrder).not.toHaveBeenCalled();
      });

      // Nothing was sent: from a creation, an ExchangeNetworkError tells the order that its outcome is unknown, the order maybe live
      it('rejects with an error that is not an ExchangeNetworkError', async () => {
        await expect(exchange.createMarketOrder('BTC/USDT', 'BUY', 1)).rejects.not.toBeInstanceOf(ExchangeNetworkError);
      });

      // The message of the ExchangeNetworkError, without its [EXCHANGE] tag
      it('rejects with a GekkoError saying that the order was not sent', async () => {
        await expect(exchange.createMarketOrder('BTC/USDT', 'BUY', 1)).rejects.toThrow(
          `[EXCHANGE] Market order not sent: ticker unavailable (${timeout.message})`,
        );
      });

      it('rejects with the ExchangeNetworkError of the ticker as the cause', async () => {
        await expect(exchange.createMarketOrder('BTC/USDT', 'BUY', 1)).rejects.toHaveProperty('cause', expect.any(ExchangeNetworkError));
      });
    });
  });
});
