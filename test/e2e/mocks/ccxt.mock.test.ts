import { ONE_MINUTE } from '@constants/time.const';
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { mapValues } from 'lodash-es';
import { generateSyntheticCandle, syntheticPrice } from '../fixtures/syntheticData';
import {
  createCcxtModuleMock,
  MockBadRequest,
  MockBadSymbol,
  MockBaseError,
  MockCCXTExchange,
  MockExchangeError,
  MockInsufficientFunds,
  MockInvalidOrder,
  MockNetworkError,
  MockOperationFailed,
  MockOrderNotFound,
  type Gap,
  type OHLCV,
  type PartialCandle,
} from './ccxt.mock';

/** The synthetic candle of the pair at minute `minute` (counted from the epoch), as ccxt hands it over */
const synthetic = (symbol: string, minute: number): OHLCV => {
  const { start, open, high, low, close, volume } = generateSyntheticCandle(symbol, minute * ONE_MINUTE);
  return [start, open, high, low, close, volume];
};

/** The minutes of a page, counted from the epoch */
const minutesOf = (page: number[][]) => page.map(([start]) => start / ONE_MINUTE);

/** Halfway through minute 1000, the minute in progress of the tests that set the clock */
const NOW = 1000 * ONE_MINUTE + ONE_MINUTE / 2;

/** What a call ended with: the name of the error it threw, or the minutes of the page it answered */
const settle = (call: Promise<number[][]>) =>
  call.then(
    page => minutesOf(page),
    (error: Error) => error.name,
  );

describe('MockCCXTExchange', () => {
  let exchange: MockCCXTExchange;

  beforeEach(() => {
    exchange = new MockCCXTExchange({});
    MockCCXTExchange.reset();
  });

  afterEach(() => setSystemTime());

  describe('markets', () => {
    it('should give each market the fees and the MARKET_LOT_SIZE range ccxt gives a Binance spot market', () => {
      const fees = mapValues(exchange.markets, ({ maker, taker, limits }) => ({ maker, taker, market: limits.market }));
      expect(fees).toEqual({
        'BTC/USDT': { maker: 0.001, taker: 0.001, market: { min: 0, max: 100 } },
        'ETH/USDT': { maker: 0.001, taker: 0.001, market: { min: 0, max: 2000 } },
        'LTC/USDT': { maker: 0.001, taker: 0.001, market: { min: 0, max: 5000 } },
      });
    });
  });

  describe('pages', () => {
    // bun:test takes no tagged-template table. Minutes are counted from the epoch, the clock set to minute 1000.
    it.each<{ title: string; since?: number; limit: number; gaps: Gap[]; expected: number[] }>([
      { title: 'the minutes from the first at or after since', since: 10 * ONE_MINUTE + 1, limit: 3, gaps: [], expected: [11, 12, 13] },
      { title: 'a since on a minute, that minute included', since: 10 * ONE_MINUTE, limit: 3, gaps: [], expected: [10, 11, 12] },
      {
        title: 'the minutes after a gap, the page going on past it',
        since: 10 * ONE_MINUTE,
        limit: 4,
        gaps: [{ start: 11 * ONE_MINUTE, end: 13 * ONE_MINUTE }],
        expected: [10, 13, 14, 15],
      },
      {
        title: 'the minutes after a gap longer than the page',
        since: 10 * ONE_MINUTE,
        limit: 2,
        gaps: [{ start: 11 * ONE_MINUTE, end: 500 * ONE_MINUTE }],
        expected: [10, 500],
      },
      {
        title: 'the first minute at or after an end off the minutes',
        since: 10 * ONE_MINUTE,
        limit: 2,
        gaps: [{ start: 10 * ONE_MINUTE, end: 12 * ONE_MINUTE + 1 }],
        expected: [13, 14],
      },
      {
        title: 'nothing after a gap without an end',
        since: 10 * ONE_MINUTE,
        limit: 5,
        gaps: [{ start: 12 * ONE_MINUTE, end: Infinity }],
        expected: [10, 11],
      },
      { title: 'nothing after the minute in progress', since: 998 * ONE_MINUTE, limit: 5, gaps: [], expected: [998, 999, 1000] },
      { title: 'nothing from a since in the future', since: 1001 * ONE_MINUTE, limit: 5, gaps: [], expected: [] },
      { title: 'the latest minutes without since', since: undefined, limit: 3, gaps: [], expected: [998, 999, 1000] },
      {
        title: 'the latest minutes before a gap without since',
        since: undefined,
        limit: 3,
        gaps: [{ start: 999 * ONE_MINUTE, end: Infinity }],
        expected: [996, 997, 998],
      },
    ])('should serve $title', async ({ since, limit, gaps, expected }) => {
      setSystemTime(new Date(NOW));
      MockCCXTExchange.simulatedGaps = gaps;
      expect(minutesOf(await exchange.fetchOHLCV('BTC/USDT', '1m', since, limit))).toEqual(expected);
    });

    it.each<{ title: string; limit?: number; expected: number }>([
      { title: 'the 500 candles ccxt asks for without a limit', limit: undefined, expected: 500 },
      { title: 'no more than the 1000 candles ccxt asks for at most', limit: 5000, expected: 1000 },
    ])('should serve $title', async ({ limit, expected }) => {
      setSystemTime(new Date(NOW));
      expect(await exchange.fetchOHLCV('BTC/USDT', '1m', 0, limit)).toHaveLength(expected);
    });

    it('should leave the pages of another pair whole for a gap of one pair', async () => {
      setSystemTime(new Date(NOW));
      MockCCXTExchange.simulatedGaps = { 'ETH/USDT': [{ start: 10 * ONE_MINUTE, end: 12 * ONE_MINUTE }] };
      const pages = {
        btc: minutesOf(await exchange.fetchOHLCV('BTC/USDT', '1m', 10 * ONE_MINUTE, 2)),
        eth: minutesOf(await exchange.fetchOHLCV('ETH/USDT', '1m', 10 * ONE_MINUTE, 2)),
      };
      expect(pages).toEqual({ btc: [10, 11], eth: [12, 13] });
    });

    it('should serve the synthetic candles of the minutes asked for', async () => {
      setSystemTime(new Date(NOW));
      expect(await exchange.fetchOHLCV('ETH/USDT', '1m', 20 * ONE_MINUTE, 2)).toEqual([
        synthetic('ETH/USDT', 20),
        synthetic('ETH/USDT', 21),
      ]);
    });
  });

  describe('synthetic candles', () => {
    // A candle no exchange serves, its close outside its high and its low, is one a candle check refuses
    it('should keep the open and the close of every candle within its high and its low', () => {
      const outside = Array.from({ length: 30000 }, (_, minute) => generateSyntheticCandle('BTC/USDT', minute * ONE_MINUTE)).filter(
        ({ open, high, low, close }) => Math.max(open, close) > high || Math.min(open, close) < low,
      );
      expect(outside).toEqual([]);
    });

    it('should close halfway to the open of the next minute, which a flat candle at the previous close does not open at', () => {
      const [candle, next] = [generateSyntheticCandle('BTC/USDT', 7 * ONE_MINUTE), generateSyntheticCandle('BTC/USDT', 8 * ONE_MINUTE)];
      expect({ close: candle.close, isNextOpen: candle.close === next.open }).toEqual({
        close: (candle.open + next.open) / 2,
        isNextOpen: false,
      });
    });
  });

  describe('predefined candles', () => {
    it('should serve them one per call, stamped with since, then synthetic pages', async () => {
      setSystemTime(new Date(NOW));
      const symbol = 'BTC/USDT';
      MockCCXTExchange.setPredefinedCandles(symbol, [
        { close: 100 },
        { close: 105, volume: 10 },
        { close: 102, high: 110, low: 100, open: 103 },
      ]);

      const pages = [
        await exchange.fetchOHLCV(symbol, '1m', 1 * ONE_MINUTE, 100),
        await exchange.fetchOHLCV(symbol, '1m', 2 * ONE_MINUTE, 100),
        await exchange.fetchOHLCV(symbol, '1m', 3 * ONE_MINUTE, 100),
        await exchange.fetchOHLCV(symbol, '1m', 4 * ONE_MINUTE + 1, 2),
      ];

      // [timestamp, open, high, low, close, volume]: the open at the close, the high and the low at the higher and the lower of the
      // two and the volume at 50 when left out, then the synthetic candles from the first minute at or after since
      expect(pages).toEqual([
        [[1 * ONE_MINUTE, 100, 100, 100, 100, 50]],
        [[2 * ONE_MINUTE, 105, 105, 105, 105, 10]],
        [[3 * ONE_MINUTE, 103, 110, 100, 102, 50]],
        [synthetic(symbol, 5), synthetic(symbol, 6)],
      ]);
    });

    it('should serve synthetic pages once resetPredefinedCandles has run', async () => {
      setSystemTime(new Date(NOW));
      MockCCXTExchange.setPredefinedCandles('BTC/USDT', [{ close: 100 }]);
      MockCCXTExchange.resetPredefinedCandles();
      expect(await exchange.fetchOHLCV('BTC/USDT', '1m', 10 * ONE_MINUTE, 2)).toEqual([
        synthetic('BTC/USDT', 10),
        synthetic('BTC/USDT', 11),
      ]);
    });
  });

  describe('fetchTicker', () => {
    const candles: PartialCandle[] = [{ open: 98, close: 100 }, { close: 110 }, { close: 120 }];

    // bun:test takes no tagged-template table
    it.each<{ title: string; served: number; expected: number }>([
      { title: 'the open of the first predefined candle before any is served', served: 0, expected: 98 },
      { title: 'the close of the last predefined candle served', served: 2, expected: 110 },
      { title: 'the close of the last predefined candle once all are served', served: 4, expected: 120 },
    ])('should quote $title', async ({ served, expected }) => {
      MockCCXTExchange.setPredefinedCandles('BTC/USDT', candles);
      for (let call = 0; call < served; call++) await exchange.fetchOHLCV('BTC/USDT', '1m', call * ONE_MINUTE, 1);
      const { bid, ask, last } = await exchange.fetchTicker('BTC/USDT');
      expect({ bid, ask, last }).toEqual({ bid: expected, ask: expected, last: expected });
    });

    it('should quote the synthetic price at the time of the call for a pair without predefined candles', async () => {
      setSystemTime(new Date(NOW));
      const { bid, ask, last } = await exchange.fetchTicker('ETH/USDT');
      const price = syntheticPrice('ETH/USDT', NOW);
      expect({ bid, ask, last }).toEqual({ bid: price, ask: price, last: price });
    });

    it('should quote every pair asked for in fetchTickers', async () => {
      setSystemTime(new Date(NOW));
      MockCCXTExchange.setPredefinedCandles('BTC/USDT', candles);
      const tickers = await exchange.fetchTickers(['BTC/USDT', 'ETH/USDT']);
      expect(mapValues(tickers, ({ last }) => last)).toEqual({ 'BTC/USDT': 98, 'ETH/USDT': syntheticPrice('ETH/USDT', NOW) });
    });
  });

  describe('lies of the exchange', () => {
    it('should stamp every X-th page with the first minute served, keeping the prices of the minutes asked for', async () => {
      setSystemTime(new Date(NOW));
      MockCCXTExchange.emitDuplicatesEveryXCandle = 2;
      const pages = [];
      for (let minute = 10; minute < 15; minute++) pages.push(await exchange.fetchOHLCV('BTC/USDT', '1m', minute * ONE_MINUTE, 1));
      const open = (minute: number) => generateSyntheticCandle('BTC/USDT', minute * ONE_MINUTE).open;
      expect(pages.map(([[start, candleOpen]]) => [start / ONE_MINUTE, candleOpen])).toEqual([
        [10, open(10)],
        [11, open(11)],
        [10, open(12)],
        [13, open(13)],
        [10, open(14)],
      ]);
    });

    it('should open every page with the candle of 5 minutes after the call', async () => {
      setSystemTime(new Date(NOW));
      MockCCXTExchange.emitFutureCandles = true;
      const page = await exchange.fetchOHLCV('BTC/USDT', '1m', 998 * ONE_MINUTE, 2);
      expect(page.map(([start]) => start)).toEqual([NOW + 5 * ONE_MINUTE, 998 * ONE_MINUTE, 999 * ONE_MINUTE]);
    });
  });

  describe('faults', () => {
    const fetchPage = () => exchange.fetchOHLCV('BTC/USDT', '1m', 10 * ONE_MINUTE, 1);

    // bun:test takes no tagged-template table
    type Fault = Partial<Pick<typeof MockCCXTExchange, 'shouldThrowError' | 'networkErrorsToThrow' | 'shouldThrowExchangeError'>>;
    it.each<{ title: string; fault: Fault; expected: (string | number[])[] }>([
      { title: 'a NetworkError on every call', fault: { shouldThrowError: true }, expected: ['NetworkError', 'NetworkError'] },
      { title: 'a NetworkError on the next call alone', fault: { networkErrorsToThrow: 1 }, expected: ['NetworkError', [10]] },
      {
        title: 'an ExchangeError on every call',
        fault: { shouldThrowExchangeError: true },
        expected: ['ExchangeError', 'ExchangeError'],
      },
    ])('should fail fetchOHLCV with $title', async ({ fault, expected }) => {
      setSystemTime(new Date(NOW));
      Object.assign(MockCCXTExchange, fault);
      expect([await settle(fetchPage()), await settle(fetchPage())]).toEqual(expected);
    });

    it('should fail createOrder with a NetworkError when shouldThrowError is set', async () => {
      MockCCXTExchange.shouldThrowError = true;
      const failure = await exchange.createOrder('BTC/USDT', 'limit', 'buy', 1, 100).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(MockNetworkError);
    });

    // What retry and translateCcxtError check: a NetworkError is an OperationFailed, an OrderNotFound an InvalidOrder
    it('should give the error classes the inheritance and the names of ccxt', () => {
      const classes = [
        MockOperationFailed,
        MockNetworkError,
        MockExchangeError,
        MockInvalidOrder,
        MockOrderNotFound,
        MockInsufficientFunds,
        MockBadRequest,
        MockBadSymbol,
      ];
      const ancestry = classes.map(ErrorClass => {
        const error = new ErrorClass('message');
        const parents = { MockBaseError, MockOperationFailed, MockExchangeError, MockInvalidOrder, MockBadRequest };
        return { name: error.name, instanceOf: Object.keys(parents).filter(key => error instanceof parents[key as keyof typeof parents]) };
      });
      expect(ancestry).toEqual([
        { name: 'OperationFailed', instanceOf: ['MockBaseError', 'MockOperationFailed'] },
        { name: 'NetworkError', instanceOf: ['MockBaseError', 'MockOperationFailed'] },
        { name: 'ExchangeError', instanceOf: ['MockBaseError', 'MockExchangeError'] },
        { name: 'InvalidOrder', instanceOf: ['MockBaseError', 'MockExchangeError', 'MockInvalidOrder'] },
        { name: 'OrderNotFound', instanceOf: ['MockBaseError', 'MockExchangeError', 'MockInvalidOrder'] },
        { name: 'InsufficientFunds', instanceOf: ['MockBaseError', 'MockExchangeError'] },
        { name: 'BadRequest', instanceOf: ['MockBaseError', 'MockExchangeError', 'MockBadRequest'] },
        { name: 'BadSymbol', instanceOf: ['MockBaseError', 'MockExchangeError', 'MockBadRequest'] },
      ]);
    });

    it('should hand the error classes to the module under ccxt names, as default and named exports', () => {
      const { default: ccxt, ...named } = createCcxtModuleMock();
      expect({ NetworkError: ccxt.NetworkError, ExchangeError: named.ExchangeError, BaseError: ccxt.BaseError }).toEqual({
        NetworkError: MockNetworkError,
        ExchangeError: MockExchangeError,
        BaseError: MockBaseError,
      });
    });
  });

  describe('reset', () => {
    // The statics a scenario sets, as each flow's beforeEach finds them
    const statics = () => ({
      simulatedGaps: MockCCXTExchange.simulatedGaps,
      shouldThrowError: MockCCXTExchange.shouldThrowError,
      networkErrorsToThrow: MockCCXTExchange.networkErrorsToThrow,
      shouldThrowExchangeError: MockCCXTExchange.shouldThrowExchangeError,
      shouldThrowOnCreateOrder: MockCCXTExchange.shouldThrowOnCreateOrder,
      emitDuplicatesEveryXCandle: MockCCXTExchange.emitDuplicatesEveryXCandle,
      emitFutureCandles: MockCCXTExchange.emitFutureCandles,
      mockTrades: MockCCXTExchange.mockTrades,
      predefinedCandles: MockCCXTExchange.predefinedCandles,
      predefinedCandlesIndex: MockCCXTExchange.predefinedCandlesIndex,
    });

    it('should put back every static a scenario sets', () => {
      MockCCXTExchange.simulatedGaps = [{ start: 0, end: ONE_MINUTE }];
      MockCCXTExchange.shouldThrowError = true;
      MockCCXTExchange.networkErrorsToThrow = 2;
      MockCCXTExchange.shouldThrowExchangeError = true;
      MockCCXTExchange.shouldThrowOnCreateOrder = true;
      MockCCXTExchange.emitDuplicatesEveryXCandle = 3;
      MockCCXTExchange.emitFutureCandles = true;
      MockCCXTExchange.mockTrades = [{ id: 'trade' }];
      MockCCXTExchange.setPredefinedCandles('BTC/USDT', [{ close: 100 }]);

      MockCCXTExchange.reset();

      expect(statics()).toEqual({
        simulatedGaps: [],
        shouldThrowError: false,
        networkErrorsToThrow: 0,
        shouldThrowExchangeError: false,
        shouldThrowOnCreateOrder: false,
        emitDuplicatesEveryXCandle: 0,
        emitFutureCandles: false,
        mockTrades: [],
        predefinedCandles: {},
        predefinedCandlesIndex: {},
      });
    });
  });
});
