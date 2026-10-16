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
  MockRequestTimeout,
  PRECISION_CONSTANTS,
  type CreationFault,
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

/** What a call to the account failed with: the name and the message of the error it threw, undefined when it answered */
const failureOf = (call: Promise<unknown>) =>
  call.then(
    () => undefined,
    (error: Error) => ({ name: error.name, message: error.message }),
  );

const { TRUNCATE, ROUND, TICK_SIZE, NO_PADDING, DECIMAL_PLACES } = PRECISION_CONSTANTS;

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
        MockRequestTimeout,
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
        { name: 'RequestTimeout', instanceOf: ['MockBaseError', 'MockOperationFailed'] },
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

    // CCXTExchange reads them from the default export (ccxt.TRUNCATE, ccxt.OperationFailed): ccxt exports them at the top of its module
    it('should hand the precision constants and RequestTimeout to the module under ccxt names, as default and named exports', () => {
      const { default: ccxt, ...named } = createCcxtModuleMock();
      expect({ TRUNCATE: ccxt.TRUNCATE, TICK_SIZE: named.TICK_SIZE, RequestTimeout: ccxt.RequestTimeout }).toEqual({
        TRUNCATE: 0,
        TICK_SIZE: 4,
        RequestTimeout: MockRequestTimeout,
      });
    });
  });

  describe('precision, as ccxt writes and rounds a number', () => {
    // bun:test takes no tagged-template table. Every expected string is what ccxt 4.5.39's binance answers.
    it.each<{ value: number | string; expected: string }>([
      { value: 1.5e-7, expected: '0.00000015' },
      { value: 1.234567e-7, expected: '0.0000001234567' },
      { value: 1e21, expected: '1000000000000000000000' },
      { value: 0.1 + 0.2, expected: '0.30000000000000004' },
      { value: 100, expected: '100' },
      { value: '12.5', expected: '12.5' },
      // A string is written as it is, an exponent included
      { value: '1e-7', expected: '1e-7' },
    ])('should write $value as $expected, without an exponent, in numberToString', ({ value, expected }) => {
      expect(exchange.numberToString(value)).toBe(expected);
    });

    it.each<{ value: number; mode: number; tick: number; expected: string }>([
      { value: 0.0000560556, mode: TRUNCATE, tick: 0.00001, expected: '0.00005' },
      { value: 0.999, mode: TRUNCATE, tick: 0.01, expected: '0.99' },
      // A truncated value is written as String writes the number
      { value: 1e-7, mode: TRUNCATE, tick: 1e-8, expected: '1e-7' },
      { value: 0.004, mode: TRUNCATE, tick: 0.01, expected: '0' },
      { value: 99.995, mode: ROUND, tick: 0.01, expected: '100' },
      { value: 99.994999, mode: ROUND, tick: 0.01, expected: '99.99' },
      // A half in decimal is rounded up, though 0.125 and 2.675 are below it in binary
      { value: 0.125, mode: ROUND, tick: 0.01, expected: '0.13' },
      { value: 2.675, mode: ROUND, tick: 0.01, expected: '2.68' },
      { value: 12345.675, mode: ROUND, tick: 0.25, expected: '12345.75' },
      { value: 7.5, mode: ROUND, tick: 1, expected: '8' },
    ])('should round $value to $expected on a tick of $tick in decimalToPrecision (mode $mode)', ({ value, mode, tick, expected }) => {
      expect(exchange.decimalToPrecision(exchange.numberToString(value), mode, tick, TICK_SIZE, NO_PADDING)).toBe(expected);
    });

    // Rounding as ccxt would in those modes is not the mock's: a mode ccxt's binance does not use fails the test that meets it
    it('should refuse a counting mode other than TICK_SIZE', () => {
      expect(() => exchange.decimalToPrecision('1.5', ROUND, 2, DECIMAL_PLACES, NO_PADDING)).toThrow(
        'The mock rounds in the TICK_SIZE counting mode without padding only, got modes 2 and 5',
      );
    });

    it('should give the precision and the padding modes of ccxt binance', () => {
      expect({ precisionMode: exchange.precisionMode, paddingMode: exchange.paddingMode }).toEqual({ precisionMode: 4, paddingMode: 5 });
    });

    // 1.0000009 rounded to the step of 0.000001 would be 1.000001
    it('should round a price to its tick, a half up, and truncate an amount to its step (priceToPrecision, amountToPrecision)', () => {
      expect({ price: exchange.priceToPrecision('BTC/USDT', 90.005), amount: exchange.amountToPrecision('BTC/USDT', 1.0000009) }).toEqual({
        price: '90.01',
        amount: '1',
      });
    });

    it.each<{ title: string; round: () => string; message: string }>([
      {
        title: 'a price rounded to 0',
        round: () => exchange.priceToPrecision('BTC/USDT', 0.004),
        message: 'binance price of BTC/USDT must be greater than minimum price precision of 0.01',
      },
      {
        title: 'an amount truncated to 0',
        round: () => exchange.amountToPrecision('BTC/USDT', 1e-7),
        message: 'binance amount of BTC/USDT must be greater than minimum amount precision of 0.000001',
      },
    ])('should refuse $title with an InvalidOrder, as ccxt does', ({ round, message }) => {
      expect(round).toThrow(new MockInvalidOrder(message));
    });
  });

  describe('the clients', () => {
    it('should keep what a client is built with, its keys read from it, and send it to the testnet with sandbox set, as ccxt does', () => {
      const userConfig = { apiKey: 'key', secret: 'secret', sandbox: true, options: { maxRetriesOnFailure: 0 } };
      const client = new MockCCXTExchange(userConfig);
      expect({
        userConfig: client.userConfig,
        apiKey: client.apiKey,
        secret: client.secret,
        isSandboxModeEnabled: client.isSandboxModeEnabled,
        hasSandbox: client.has.sandbox,
        isListed: MockCCXTExchange.clients.includes(client),
      }).toEqual({ userConfig, apiKey: 'key', secret: 'secret', isSandboxModeEnabled: true, hasSandbox: true, isListed: true });
    });

    // CCXTExchange.loadMarkets writes there what the public client learned, which a flow reads
    it('should start every client with empty options, whatever the options it is built with', () => {
      expect(new MockCCXTExchange({ options: { maxRetriesOnFailure: 0 } }).options).toEqual({});
    });

    it('should leave a client built without sandbox on the exchange itself', () => {
      expect(new MockCCXTExchange({ apiKey: 'key', secret: 'secret' }).isSandboxModeEnabled).toBe(false);
    });

    // The client of the tests was built before the reset of beforeEach, which emptied the list
    it('should list the clients in the order they were built', () => {
      const [publicClient, privateClient] = [new MockCCXTExchange({}), new MockCCXTExchange({ apiKey: 'key' })];
      const names = new Map([
        [publicClient, 'public'],
        [privateClient, 'private'],
      ]);
      expect(MockCCXTExchange.clients.map(client => names.get(client))).toEqual(['public', 'private']);
    });
  });

  describe('the account', () => {
    const BTC = 'BTC/USDT';
    // The ticker follows the predefined candles: 100 once the first one is served, 110 once the second is (see fetchTicker)
    const serveCandles = async (count: number) => {
      for (let call = 0; call < count; call++) await exchange.fetchOHLCV(BTC, '1m', call * ONE_MINUTE, 1);
    };
    /** An order as the scenarios pin it, without its dates */
    const describeOrder = ({ id, type, side, price, amount, filled, remaining, status }: Record<string, any>) => ({
      id,
      type,
      side,
      price,
      amount,
      filled,
      remaining,
      status,
    });
    /** A trade of the account as the scenarios pin it, without its dates and the answer it was parsed from */
    const describeTrade = ({ id, order, side, takerOrMaker, price, amount, cost, fee }: Record<string, any>) => ({
      id,
      order,
      side,
      takerOrMaker,
      price,
      amount,
      cost,
      fee,
    });

    beforeEach(() => {
      setSystemTime(new Date(NOW));
      MockCCXTExchange.setBalances({ BTC: 0, USDT: 10000 });
      MockCCXTExchange.setPredefinedCandles(BTC, [
        { close: 100 },
        { close: 110 },
        { open: 95, low: 89, close: 92, volume: 0.4 },
        { open: 92, high: 112, close: 111, volume: 0.5 },
      ]);
    });

    it('should answer a MARKET BUY closed with its fill at the ask, its taker fee taken in the asset bought, as Binance does', async () => {
      await serveCandles(1);
      const answer = await exchange.createOrder(BTC, 'market', 'BUY', 1, 99);
      expect({
        answer: { ...describeOrder(answer), timestamp: answer.timestamp, average: answer.average, cost: answer.cost },
        trades: answer.trades.map(describeTrade),
        balances: MockCCXTExchange.getBalances(),
      }).toEqual({
        // The price sent with a MARKET order is ignored, as Binance ignores it: the order fills at the ask, the ticker of 100
        answer: {
          id: '1',
          type: 'market',
          side: 'buy',
          price: 100,
          amount: 1,
          filled: 1,
          remaining: 0,
          status: 'closed',
          timestamp: NOW,
          average: 100,
          cost: 100,
        },
        trades: [
          {
            id: '1',
            order: '1',
            side: 'buy',
            takerOrMaker: 'taker',
            price: 100,
            amount: 1,
            cost: 100,
            fee: { cost: 0.001, currency: 'BTC' },
          },
        ],
        balances: { BTC: { free: 0.999, used: 0, total: 0.999 }, USDT: { free: 9900, used: 0, total: 9900 } },
      });
    });

    it('should take the fee of a SELL in the currency it brings in', async () => {
      MockCCXTExchange.setBalances({ BTC: 1, USDT: 0 });
      await serveCandles(2);
      await exchange.createOrder(BTC, 'market', 'sell', 0.999, 110);
      // 0.999 at 110 brings 109.89, less 0.1 % of it, 0.10989
      expect(MockCCXTExchange.getBalances()).toEqual({
        BTC: { free: 0.001, used: 0, total: 0.001 },
        USDT: { free: 109.78011, used: 0, total: 109.78011 },
      });
    });

    it('should place an order on the step and the tick of its market, as ccxt sends it: amount truncated, price rounded', async () => {
      await serveCandles(1);
      await exchange.createOrder(BTC, 'limit', 'buy', 1.0000009, 90.005);
      expect(MockCCXTExchange.getOrders().map(describeOrder)).toEqual([
        { id: '1', type: 'limit', side: 'buy', price: 90.01, amount: 1, filled: 0, remaining: 1, status: 'open' },
      ]);
    });

    it('should rest a LIMIT BUY below the ask, open, the cost of what it has left reserved', async () => {
      await serveCandles(1);
      const answer = await exchange.createOrder(BTC, 'limit', 'buy', 1, 90);
      expect({ answer: describeOrder(answer), balances: MockCCXTExchange.getBalances() }).toEqual({
        answer: { id: '1', type: 'limit', side: 'buy', price: 90, amount: 1, filled: 0, remaining: 1, status: 'open' },
        balances: { BTC: { free: 0, used: 0, total: 0 }, USDT: { free: 9910, used: 90, total: 10000 } },
      });
    });

    it('should fill a LIMIT SELL at or below the bid at once, at the bid, as a taker', async () => {
      MockCCXTExchange.setBalances({ BTC: 1, USDT: 0 });
      await serveCandles(1);
      const answer = await exchange.createOrder(BTC, 'limit', 'sell', 1, 95);
      expect(answer.trades.map(describeTrade)).toEqual([
        {
          id: '1',
          order: '1',
          side: 'sell',
          takerOrMaker: 'taker',
          price: 100,
          amount: 1,
          cost: 100,
          fee: { cost: 0.1, currency: 'USDT' },
        },
      ]);
    });

    it.each<{ title: string; side: string; amount: number }>([
      { title: 'a BUY whose cost at the ask exceeds the free currency', side: 'buy', amount: 101 },
      { title: 'a SELL of more than the free asset', side: 'sell', amount: 0.5 },
    ])('should refuse $title with an InsufficientFunds, as Binance does, nothing placed', async ({ side, amount }) => {
      await serveCandles(1);
      const failure = await failureOf(exchange.createOrder(BTC, 'market', side, amount, 100));
      expect({ failure, orders: MockCCXTExchange.getOrders() }).toEqual({
        failure: { name: 'InsufficientFunds', message: 'binance Account has insufficient balance for requested action.' },
        orders: [],
      });
    });

    it('should refuse an order on a market the exchange does not have, with a BadSymbol', async () => {
      expect(await failureOf(exchange.createOrder('DOGE/USDT', 'market', 'buy', 1, 100))).toEqual({
        name: 'BadSymbol',
        message: 'binance does not have market symbol DOGE/USDT',
      });
    });

    it('should answer a creation open while matchesOrdersAtCreation is false, and match it at the next call to the account', async () => {
      MockCCXTExchange.matchesOrdersAtCreation = false;
      await serveCandles(1);
      const answer = await exchange.createOrder(BTC, 'market', 'buy', 1, 100);
      const polled = await exchange.fetchOrder('1', BTC);
      expect({ answer: answer.status, polled: describeOrder(polled) }).toEqual({
        answer: 'open',
        polled: { id: '1', type: 'market', side: 'buy', price: 100, amount: 1, filled: 1, remaining: 0, status: 'closed' },
      });
    });

    it('should trade a resting LIMIT BUY at its price, as a maker, with a later candle whose low reaches it, for its volume', async () => {
      await serveCandles(2);
      await exchange.createOrder(BTC, 'limit', 'buy', 1, 90);
      // Candle 2 dips to 89, trading 0.4: the BUY fills 0.4 at 90 at the first call, and nothing more at the next one
      await serveCandles(1);
      const [first, second] = [await exchange.fetchOrder('1', BTC), await exchange.fetchOrder('1', BTC)];
      expect({ fills: [first.filled, second.filled], trades: MockCCXTExchange.mockTrades.map(describeTrade) }).toEqual({
        fills: [0.4, 0.4],
        trades: [
          {
            id: '1',
            order: '1',
            side: 'buy',
            takerOrMaker: 'maker',
            price: 90,
            amount: 0.4,
            cost: 36,
            fee: { cost: 0.0004, currency: 'BTC' },
          },
        ],
      });
    });

    it('should not trade a resting order with a candle served before it was placed', async () => {
      await serveCandles(3);
      await exchange.createOrder(BTC, 'limit', 'buy', 1, 90);
      expect((await exchange.fetchOrder('1', BTC)).filled).toBe(0);
    });

    it('should share the volume of a candle between the resting orders it fills, the oldest first', async () => {
      await serveCandles(2);
      await exchange.createOrder(BTC, 'limit', 'buy', 0.3, 90);
      await exchange.createOrder(BTC, 'limit', 'buy', 0.3, 91);
      await serveCandles(1);
      await exchange.fetchBalance();
      // Candle 2 trades 0.4 at 89 or above: 0.3 for the first BUY, which is filled, the 0.1 left for the second
      expect(MockCCXTExchange.getOrders().map(({ id, filled, status }) => ({ id, filled, status }))).toEqual([
        { id: '1', filled: 0.3, status: 'closed' },
        { id: '2', filled: 0.1, status: 'open' },
      ]);
    });

    it('should trade a resting LIMIT SELL with a later candle whose high reaches it', async () => {
      MockCCXTExchange.setBalances({ BTC: 1, USDT: 0 });
      await serveCandles(3);
      await exchange.createOrder(BTC, 'limit', 'sell', 1, 112);
      await serveCandles(1);
      // Candle 3 reaches 112, trading 0.5
      expect(describeOrder(await exchange.fetchOrder('1', BTC))).toEqual({
        id: '1',
        type: 'limit',
        side: 'sell',
        price: 112,
        amount: 1,
        filled: 0.5,
        remaining: 0.5,
        status: 'open',
      });
    });

    it('should cancel an open order with what it filled, dated with the cancelation, its reserve released', async () => {
      await serveCandles(2);
      await exchange.createOrder(BTC, 'limit', 'buy', 1, 90);
      await serveCandles(1);
      setSystemTime(new Date(NOW + ONE_MINUTE));
      const answer = await exchange.cancelOrder('1', BTC);
      expect({ answer: { ...describeOrder(answer), timestamp: answer.timestamp }, balances: MockCCXTExchange.getBalances() }).toEqual({
        answer: {
          id: '1',
          type: 'limit',
          side: 'buy',
          price: 90,
          amount: 1,
          filled: 0.4,
          remaining: 0.6,
          status: 'canceled',
          timestamp: NOW + ONE_MINUTE,
        },
        balances: { BTC: { free: 0.3996, used: 0, total: 0.3996 }, USDT: { free: 9964, used: 0, total: 9964 } },
      });
    });

    it('should give each order the status Binance answers it with, which ccxt parses (info)', async () => {
      await serveCandles(2);
      await exchange.createOrder(BTC, 'market', 'buy', 1, 110);
      await exchange.createOrder(BTC, 'limit', 'buy', 1, 90);
      await exchange.createOrder(BTC, 'limit', 'buy', 0.1, 80);
      await exchange.cancelOrder('3', BTC);
      // Candle 2 dips to 89: the BUY at 90 fills 0.4 of its 1, the one at 80 nothing
      await serveCandles(1);
      await exchange.fetchBalance();
      expect(MockCCXTExchange.getOrders().map(({ info }) => info.status)).toEqual(['FILLED', 'PARTIALLY_FILLED', 'CANCELED']);
    });

    it('should give an order no fill yet the status NEW', async () => {
      await serveCandles(1);
      await exchange.createOrder(BTC, 'limit', 'buy', 1, 90);
      expect(MockCCXTExchange.getOrders()[0].info.status).toBe('NEW');
    });

    it('should date an order it is asked about with its creation and its last update', async () => {
      await serveCandles(2);
      await exchange.createOrder(BTC, 'limit', 'buy', 1, 90);
      await serveCandles(1);
      setSystemTime(new Date(NOW + ONE_MINUTE));
      const { timestamp, lastUpdateTimestamp } = await exchange.fetchOrder('1', BTC);
      expect({ timestamp, lastUpdateTimestamp }).toEqual({ timestamp: NOW, lastUpdateTimestamp: NOW + ONE_MINUTE });
    });

    it.each<{ title: string; call: (exchange: MockCCXTExchange) => Promise<unknown>; message: string }>([
      {
        title: 'the cancelation of an order that is not open',
        call: async client => {
          await client.createOrder(BTC, 'market', 'buy', 1, 100);
          return client.cancelOrder('1', BTC);
        },
        message: 'binance {"code":-2011,"msg":"Unknown order sent."}',
      },
      {
        title: 'the query of an order the account never placed',
        call: client => client.fetchOrder('7', BTC),
        message: 'binance {"code":-2013,"msg":"Order does not exist."}',
      },
    ])('should answer $title with an OrderNotFound, as Binance does', async ({ call, message }) => {
      await serveCandles(1);
      expect(await failureOf(call(exchange))).toEqual({ name: 'OrderNotFound', message });
    });

    it('should list the orders open on the pair, those placed before the run included, oldest first, with what each has left', async () => {
      MockCCXTExchange.setBalances({ BTC: 2, USDT: 10000 });
      MockCCXTExchange.addOpenOrder({ symbol: BTC, side: 'buy', type: 'limit', amount: 0.5, price: 95, filled: 0.2 });
      MockCCXTExchange.addOpenOrder({ symbol: BTC, side: 'sell', type: 'stop_loss_limit', amount: 1, price: 90, triggerPrice: 92 });
      MockCCXTExchange.addOpenOrder({ symbol: 'ETH/USDT', side: 'buy', type: 'limit', amount: 1, price: 1000 });
      await serveCandles(1);
      await exchange.createOrder(BTC, 'market', 'buy', 1, 100);
      await exchange.createOrder(BTC, 'limit', 'sell', 0.5, 130);
      const open = await exchange.fetchOpenOrders(BTC);
      expect(open.map(order => ({ ...describeOrder(order), triggerPrice: order.triggerPrice }))).toEqual([
        {
          id: '1',
          type: 'limit',
          side: 'buy',
          price: 95,
          amount: 0.5,
          filled: 0.2,
          remaining: 0.3,
          status: 'open',
          triggerPrice: undefined,
        },
        { id: '2', type: 'stop_loss_limit', side: 'sell', price: 90, amount: 1, filled: 0, remaining: 1, status: 'open', triggerPrice: 92 },
        {
          id: '5',
          type: 'limit',
          side: 'sell',
          price: 130,
          amount: 0.5,
          filled: 0,
          remaining: 0.5,
          status: 'open',
          triggerPrice: undefined,
        },
      ]);
    });

    it('should never trade a conditional order, which waits for its trigger price off the book', async () => {
      MockCCXTExchange.setBalances({ BTC: 1, USDT: 0 });
      MockCCXTExchange.addOpenOrder({ symbol: BTC, side: 'sell', type: 'limit', amount: 1, price: 100, triggerPrice: 120 });
      await serveCandles(4);
      expect((await exchange.fetchOrder('1', BTC)).filled).toBe(0);
    });

    it('should reserve what the orders open hold: a BUY the cost of what it has left, a SELL what it has left of the asset', async () => {
      MockCCXTExchange.setBalances({ BTC: 2, USDT: 10000 });
      MockCCXTExchange.addOpenOrder({ symbol: BTC, side: 'buy', type: 'limit', amount: 0.5, price: 95, filled: 0.2 });
      MockCCXTExchange.addOpenOrder({ symbol: BTC, side: 'sell', type: 'stop_loss_limit', amount: 1, price: 90, triggerPrice: 92 });
      expect(MockCCXTExchange.getBalances()).toEqual({
        BTC: { free: 1, used: 1, total: 2 },
        // 0.3 left at 95
        USDT: { free: 9971.5, used: 28.5, total: 10000 },
      });
    });

    it('should answer the trades of the pair from the first at or after since, oldest first, no more than limit', async () => {
      MockCCXTExchange.setBalances({ BTC: 0, USDT: 10000, ETH: 0 });
      MockCCXTExchange.setPredefinedCandles('ETH/USDT', [{ close: 1000 }]);
      await serveCandles(1);
      await exchange.fetchOHLCV('ETH/USDT', '1m', 0, 1);
      await exchange.createOrder(BTC, 'market', 'buy', 1, 100);
      await exchange.createOrder('ETH/USDT', 'market', 'buy', 1, 1000);
      setSystemTime(new Date(NOW + ONE_MINUTE));
      await exchange.createOrder(BTC, 'market', 'buy', 2, 100);
      await exchange.createOrder(BTC, 'market', 'buy', 3, 100);
      const pages = [await exchange.fetchMyTrades(BTC, NOW + ONE_MINUTE, 1), await exchange.fetchMyTrades(BTC)];
      expect(pages.map(page => page.map(({ order }) => order))).toEqual([['3'], ['1', '3', '4']]);
    });

    it('should give a trade the fields ccxt gives one of Binance: no fee rate, the fee in the currency it was taken in', async () => {
      await serveCandles(1);
      await exchange.createOrder(BTC, 'market', 'buy', 1, 100);
      const [trade] = await exchange.fetchMyTrades(BTC);
      expect(trade).toEqual({
        info: {
          symbol: 'BTCUSDT',
          id: '1',
          orderId: '1',
          price: '100',
          qty: '1',
          quoteQty: '100',
          commission: '0.001',
          commissionAsset: 'BTC',
          time: NOW,
          isBuyer: true,
          isMaker: false,
        },
        timestamp: NOW,
        datetime: new Date(NOW).toISOString(),
        symbol: BTC,
        id: '1',
        order: '1',
        type: undefined,
        side: 'buy',
        takerOrMaker: 'taker',
        price: 100,
        amount: 1,
        cost: 100,
        fee: { cost: 0.001, currency: 'BTC' },
        fees: [{ cost: 0.001, currency: 'BTC' }],
      });
    });

    it('should answer the balance by currency, then by free, used and total, as ccxt does', async () => {
      MockCCXTExchange.setBalances({ BTC: 1, USDT: 100 });
      await serveCandles(1);
      await exchange.createOrder(BTC, 'limit', 'buy', 0.5, 90);
      expect(await exchange.fetchBalance()).toEqual({
        info: {},
        timestamp: NOW,
        datetime: new Date(NOW).toISOString(),
        BTC: { free: 1, used: 0, total: 1 },
        USDT: { free: 55, used: 45, total: 100 },
        free: { BTC: 1, USDT: 55 },
        used: { BTC: 0, USDT: 45 },
        total: { BTC: 1, USDT: 100 },
      });
    });

    it('should record every call to the account as it was received, the calls of the market data aside', async () => {
      await serveCandles(1);
      await exchange.fetchTicker(BTC);
      await exchange.createOrder(BTC, 'limit', 'BUY', 1.0000009, 90.005);
      await exchange.fetchOrder('1', BTC);
      await exchange.cancelOrder('1', BTC);
      await exchange.fetchOpenOrders(BTC);
      await exchange.fetchMyTrades(BTC, NOW, 10);
      await exchange.fetchBalance();
      expect(MockCCXTExchange.accountCalls).toEqual([
        { method: 'createOrder', symbol: BTC, type: 'limit', side: 'BUY', amount: 1.0000009, price: 90.005 },
        { method: 'fetchOrder', id: '1', symbol: BTC },
        { method: 'cancelOrder', id: '1', symbol: BTC },
        { method: 'fetchOpenOrders', symbol: BTC },
        { method: 'fetchMyTrades', symbol: BTC, since: NOW, limit: 10 },
        { method: 'fetchBalance' },
      ]);
    });

    describe('creation faults', () => {
      // Each fault befalls an order the exchange has placed, and matched: the MARKET BUY of 1 at 100 executed
      const EXECUTED = [{ id: '1', type: 'market', side: 'buy', price: 100, amount: 1, filled: 1, remaining: 0, status: 'closed' }];

      it.each<{ title: string; fault: CreationFault; isSandbox: boolean; failure: { name: string; message: string } }>([
        {
          title: 'an answer lost on the network, a RequestTimeout from the testnet',
          fault: 'answerLost',
          isSandbox: true,
          failure: {
            name: 'RequestTimeout',
            message: 'binance POST https://testnet.binance.vision/api/v3/order request timed out (10000 ms)',
          },
        },
        {
          title: 'an answer lost on the network, a RequestTimeout from Binance itself',
          fault: 'answerLost',
          isSandbox: false,
          failure: { name: 'RequestTimeout', message: 'binance POST https://api.binance.com/api/v3/order request timed out (10000 ms)' },
        },
        {
          title: "Binance's -1006, an OperationFailed",
          fault: 'statusUnknown',
          isSandbox: true,
          failure: {
            name: 'OperationFailed',
            message: 'binance {"code":-1006,"msg":"An unexpected response was received from the message bus. Execution status unknown."}',
          },
        },
      ])('should fail the creation with $title, the order placed and executed all the same', async ({ fault, isSandbox, failure }) => {
        const client = new MockCCXTExchange({ sandbox: isSandbox });
        MockCCXTExchange.creationFaults = [fault];
        await serveCandles(1);
        const caught = await failureOf(client.createOrder(BTC, 'market', 'buy', 1, 100));
        expect({ caught, orders: MockCCXTExchange.getOrders().map(describeOrder) }).toEqual({ caught: failure, orders: EXECUTED });
      });

      it('should answer a creation without the id and the status of its order for answerWithoutId, the order placed', async () => {
        MockCCXTExchange.creationFaults = ['answerWithoutId'];
        await serveCandles(1);
        const { id, status } = await exchange.createOrder(BTC, 'market', 'buy', 1, 100);
        expect({ id, status, orders: MockCCXTExchange.getOrders().map(describeOrder) }).toEqual({
          id: undefined,
          status: undefined,
          orders: EXECUTED,
        });
      });

      it('should let a fault befall one creation only, the next one answered', async () => {
        MockCCXTExchange.creationFaults = ['answerLost'];
        await serveCandles(1);
        await failureOf(exchange.createOrder(BTC, 'market', 'buy', 1, 100));
        expect((await exchange.createOrder(BTC, 'market', 'buy', 1, 100)).status).toBe('closed');
      });

      // retry and translateCcxtError tell the two apart: an OperationFailed that is not a NetworkError is an unknown outcome of its own
      it('should throw for statusUnknown an OperationFailed that is not a NetworkError', async () => {
        MockCCXTExchange.creationFaults = ['statusUnknown'];
        await serveCandles(1);
        const failure = await exchange.createOrder(BTC, 'market', 'buy', 1, 100).catch((error: unknown) => error);
        expect({ isOperationFailed: failure instanceof MockOperationFailed, isNetworkError: failure instanceof MockNetworkError }).toEqual({
          isOperationFailed: true,
          isNetworkError: false,
        });
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
      matchesOrdersAtCreation: MockCCXTExchange.matchesOrdersAtCreation,
      creationFaults: MockCCXTExchange.creationFaults,
      accountCalls: MockCCXTExchange.accountCalls,
      clients: MockCCXTExchange.clients,
      balances: MockCCXTExchange.getBalances(),
      orders: MockCCXTExchange.getOrders(),
    });

    it('should put back every static a scenario sets, and the account as it is at load', async () => {
      MockCCXTExchange.simulatedGaps = [{ start: 0, end: ONE_MINUTE }];
      MockCCXTExchange.shouldThrowError = true;
      MockCCXTExchange.networkErrorsToThrow = 2;
      MockCCXTExchange.shouldThrowExchangeError = true;
      MockCCXTExchange.shouldThrowOnCreateOrder = true;
      MockCCXTExchange.emitDuplicatesEveryXCandle = 3;
      MockCCXTExchange.emitFutureCandles = true;
      MockCCXTExchange.mockTrades = [{ id: 'trade' }];
      MockCCXTExchange.setPredefinedCandles('BTC/USDT', [{ close: 100 }]);
      MockCCXTExchange.matchesOrdersAtCreation = false;
      MockCCXTExchange.creationFaults = ['answerLost'];
      MockCCXTExchange.setBalances({ BTC: 3 });
      MockCCXTExchange.addOpenOrder({ symbol: 'BTC/USDT', side: 'sell', type: 'limit', amount: 1, price: 120 });
      await new MockCCXTExchange({}).fetchBalance();

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
        matchesOrdersAtCreation: true,
        creationFaults: [],
        accountCalls: [],
        clients: [],
        balances: {
          USDT: { free: 10000, used: 0, total: 10000 },
          BTC: { free: 1, used: 0, total: 1 },
          ETH: { free: 10, used: 0, total: 10 },
          LTC: { free: 10, used: 0, total: 10 },
        },
        orders: [],
      });
    });
  });
});
