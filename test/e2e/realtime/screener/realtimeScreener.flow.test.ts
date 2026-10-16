import { ONE_MINUTE, ONE_SECOND } from '@constants/time.const';
import { ApplicationStopError } from '@errors/applicationStop.error';
import type { LogLevel } from '@models/logLevel.types';
import type { Tag } from '@models/tag.types';
import type { DummyCentralizedExchange } from '@services/exchange/dummy/dummyCentralizedExchange';
import { ExchangeNetworkError } from '@services/exchange/exchange.error';
import type { DebugAdviceParams } from '@strategies/debug/debugAdvice.types';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { minuteOf, startFakeClock } from '../../helpers/clock.helper';
import { mockConfiguration, paperExchange } from '../../helpers/configuration.helper';
import { endRealtimeRun, mockRealtimeModules, runRealtimeUntil, runRealtimeUntilEnd } from '../../helpers/realtimeRun.helper';
import { MockCCXTExchange } from '../../mocks/ccxt.mock';
import { MockFetcherService, SUBSCRIBE_ALL_UPDATES } from '../../mocks/fetcher.mock';
import { clearLogs, findTextLine, isTextLine, logStore } from '../../mocks/winston.mock';

// --------------------------------------------------------------------------
// MOCKS SETUP
// --------------------------------------------------------------------------

// DebugAdvice advises on every candle (each: 1), on every pair: a STICKY SELL of 1 unit, then a BUY, and so on
const DEFAULT_MOCK_STRATEGY_CONFIG: { name: string } & Partial<DebugAdviceParams> = { name: 'DebugAdvice', each: 1 };

const TELEGRAM_TOKEN = 'test-token';
const TELEGRAM_USERNAME = 'test-bot';

// 1. Mock winston, ccxt and the fetcher. Each run goes on real minutes under the fake clock, and is ended before the next one starts
// (see realtimeRun.helper)
mockRealtimeModules();
// The flows read the strategy's debug lines from the winston mock: the logger hands a debug line to winston only when
// GEKKO_LOG_LEVEL lets it through, and the logger is loaded after this, by the pipeline
process.env.GEKKO_LOG_LEVEL = 'debug';

// 2. Mock Configuration
let mockStrategyConfig = DEFAULT_MOCK_STRATEGY_CONFIG;
// Left out, the default of the schema
let mockOrderSynchInterval: number | undefined;
mockConfiguration(() => ({
  watch: {
    mode: 'realtime',
    assets: ['BTC', 'ETH'],
    currency: 'USDT',
    timeframe: '1m',
    tickrate: 100,
    warmup: { candleCount: 0, tickrate: 100 },
  },
  exchange: {
    ...paperExchange([
      { assetName: 'BTC', balance: 100 },
      { assetName: 'ETH', balance: 100 },
      { assetName: 'USDT', balance: 300000 },
    ]),
    orderSynchInterval: mockOrderSynchInterval,
  },
  plugins: [
    { name: 'TradingAdvisor', strategyName: 'DebugAdvice' },
    { name: 'Trader' },
    { name: 'EventSubscriber', token: TELEGRAM_TOKEN, botUsername: TELEGRAM_USERNAME },
  ],
  strategy: mockStrategyConfig,
}));

// --------------------------------------------------------------------------
// HELPERS
// --------------------------------------------------------------------------

/**
 * Sets up a run: the injecter, the logs, the posts and the ccxt mock as at load, the strategy and the order polls of the configuration
 * back to their defaults, and the fake clock started at REALTIME_START (see clock.helper). The chat subscribes to every notification
 * with the command the bot's first poll gets; an unbound bot first drops what was queued before start-up (offset=-1), here nothing.
 */
const setUpRun = async () => {
  const { inject } = await import('@services/injecter/injecter');
  inject.reset();
  clearLogs();
  MockFetcherService.reset();
  let polls = 0;
  MockFetcherService.when('getUpdates').thenReturn((url: string) => {
    if (url.includes('offset=-1')) return { ok: true, result: [] };
    return ++polls === 1 ? SUBSCRIBE_ALL_UPDATES : { ok: true, result: [] };
  });
  MockCCXTExchange.reset();
  mockStrategyConfig = DEFAULT_MOCK_STRATEGY_CONFIG;
  mockOrderSynchInterval = undefined;
  startFakeClock();
};

/**
 * Predefined candles closing at `sellCandleClose` on the candles DebugAdvice sells on (the even ones, from the first) and at
 * `buyCandleClose` on those it buys on, enough for every run of the file. A STICKY order is priced one price.min inside the ticker, the
 * close of the last candle served, and the paper exchange's simulator fills a SELL on a high at or above its price, a BUY on a low at or
 * below it. When the buy candles close higher, each order fills on the candle after its own, unmoved, the ticker never past it; when they
 * close lower, that candle does not reach it, and it rests until a poll after that candle moves it (see Scenario E).
 */
const zigzag = (sellCandleClose: number, buyCandleClose: number) =>
  Array.from({ length: 20 }, (_, index) => ({ close: index % 2 ? buyCandleClose : sellCandleClose }));

/** The ids the orders are given, random UUIDs, which the posts quote */
const ORDER_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** An advice relay opens with the id of its order, then says what was advised on which pair */
const ADVICE = /^Order Id: (\S+)\nReceived \w+ (BUY|SELL) advice for ([A-Z0-9]+)\//;

/** The name namedPosts gives an order, or the one it writes for an id no advice brought */
const ORDER_NAME = /<[A-Z0-9]+ (?:BUY|SELL) \d+>|<an order never advised>/;

/**
 * The messages the bot posted so far, oldest first, each order id replaced by the name of its order, after the advice relay that brought
 * the id: `<BTC SELL 1>` for the first order advised on BTC, a SELL, `<BTC BUY 2>` for the second. The ids are drawn at random: named,
 * the messages can be pinned whole, and a relay quoting an id that no advice brought reads `<an order never advised>`.
 */
const namedPosts = () => {
  const texts = MockFetcherService.postedTexts();
  const names = new Map<string, string>();
  const advisedByAsset = new Map<string, number>();
  for (const text of texts) {
    const [, id, side, asset] = text.match(ADVICE) ?? [];
    if (!id) continue;
    const count = (advisedByAsset.get(asset) ?? 0) + 1;
    advisedByAsset.set(asset, count);
    names.set(id, `<${asset} ${side} ${count}>`);
  }
  return texts.map(text => text.replace(ORDER_ID, id => names.get(id) ?? '<an order never advised>'));
};

/** The posts holding any of `markers` (an order's name, the words of a notification), in the order they went out */
const postsWith = (...markers: string[]) => namedPosts().filter(text => markers.some(marker => text.includes(marker)));

/**
 * The line naming an order in each post holding `marker`, in the order they went out: the first line of an order notification, the line
 * a strategy logged, the id line of an advice or of a cancellation request
 */
const relays = (marker: string) => postsWith(marker).map(text => text.split('\n').find(line => ORDER_NAME.test(line)));

/** A message as the bot posts it, from its lines */
const message = (...lines: string[]) => lines.join('\n');

/** A line the strategy logged at info level, as the EventSubscriber relays it, dated with the close of the candle being processed */
const strategyLog = (at: string, line: string) => `• ${at} [INFO] (strategy)\n${line}\n------\n`;

/** The lines logged as text under `tag` at `level`, oldest first */
const linesOf = (tag: Uppercase<Tag>, level: LogLevel) =>
  logStore
    .filter(isTextLine)
    .filter(line => line._tag === tag && line.level === level)
    .map(({ message }) => message);

/** The reason an order lost on the network at its creation ends with: placed or not, nobody knows */
const OUTCOME_UNKNOWN =
  'Outcome unknown: the order may be live on the exchange, check it before placing it again (Simulated Network Error)';

// --------------------------------------------------------------------------
// TEST SUITE
// --------------------------------------------------------------------------

describe('E2E: Realtime Screener Flow', () => {
  // Scenarios A-D read one run, which the hooks of their own describe set up and end, rather than hooks shared with E-G: Bun runs a
  // nested beforeAll before the beforeEach of an enclosing describe, which would set up the next run over it, and the enclosing
  // afterEach would end the run after the first test.
  describe('one run of 5 candles: on each, DebugAdvice advises BTC and ETH, and every order fills on the next candle', () => {
    beforeAll(async () => {
      await setUpRun();
      // BTC closes at 100 on the candles DebugAdvice sells on, 110 on those it buys on; ETH at 2000 and 2200
      MockCCXTExchange.setPredefinedCandles('BTC/USDT', zigzag(100, 110));
      MockCCXTExchange.setPredefinedCandles('ETH/USDT', zigzag(2000, 2200));
      // The candles of 12:00 to 12:04, one a minute from 12:01:02: until the strategy's lines on the completion of the BUYs advised on
      // the second candle have gone out, with the fifth
      await runRealtimeUntil(() => relays('Order Completed: ').length === 4, { maxMinutes: 6 });
    });

    afterAll(() => endRealtimeRun());

    it('Scenario A: 1 BTC advised to SELL at 100 then BUY at 110, filled by the next candle: completed at 99.8001 and 110.2101', () => {
      // The Trader places the STICKY SELL advised on the candle of 12:00 one price.min (0.1) under the ticker, at 99.9, which the high of
      // the next candle reaches, and the BUY advised on that one at 110.1, which the low of 12:02 reaches. A poll of the order sees it
      // filled, and the Trader reports it with the next candle, as the strategy hears of it: the strategy's line goes out with the next.
      // The simulator takes Binance's 0.1 % fee out of the SELL's proceeds, 99.9 - 0.0999, and adds it to the BUY's cost, 110.1 + 0.1101.
      // The currency is shared with ETH, whose orders fill on the same candles: 300,000 + 99.8001 + 1,997.99001 after the SELLs, then
      // 110.2101 and 2,202.21001 less after the BUYs. The BUY, created before the Trader saw the SELL filled, shows the balances before it.
      expect(postsWith('<BTC SELL 1>', '<BTC BUY 2>')).toEqual([
        message(
          'Order Id: <BTC SELL 1>',
          'Received STICKY SELL advice for BTC/USDT',
          'Requested amount: 1',
          'At time: 2024-01-01T12:01:00.000Z',
          'Target price: 100 USDT',
          '------',
        ),
        message(
          'SELL STICKY order created (<BTC SELL 1>) for BTC/USDT',
          'Requested amount: 1',
          'Current symbol portfolio: 100 BTC / 300,000 USDT',
          'Target price: 100 USDT',
          'At time: 2024-01-01T12:01:00.000Z',
          '------',
        ),
        message(
          'Order Id: <BTC BUY 2>',
          'Received STICKY BUY advice for BTC/USDT',
          'Requested amount: 1',
          'At time: 2024-01-01T12:02:00.000Z',
          'Target price: 110 USDT',
          '------',
        ),
        message(
          'BUY STICKY order created (<BTC BUY 2>) for BTC/USDT',
          'Requested amount: 1',
          'Current symbol portfolio: 100 BTC / 300,000 USDT',
          'Target price: 110 USDT',
          'At time: 2024-01-01T12:02:00.000Z',
          '------',
        ),
        message(
          'SELL STICKY order completed (<BTC SELL 1>) for BTC/USDT',
          'Amount: 1 BTC',
          'Price: 99.8001 USDT',
          'Fee percent: 0.1%',
          'Fee: 0.0999 USDT',
          'At time: 2024-01-01T12:02:00.000Z',
          'Current portfolio: 99 BTC / 302,097.79011 USDT',
          '------',
        ),
        strategyLog('2024-01-01T12:03:00.000Z', 'Order Completed: <BTC SELL 1>'),
        message(
          'BUY STICKY order completed (<BTC BUY 2>) for BTC/USDT',
          'Amount: 1 BTC',
          'Price: 110.2101 USDT',
          'Fee percent: 0.1%',
          'Fee: 0.1101 USDT',
          'At time: 2024-01-01T12:03:00.000Z',
          'Current portfolio: 100 BTC / 299,785.37 USDT',
          '------',
        ),
        strategyLog('2024-01-01T12:04:00.000Z', 'Order Completed: <BTC BUY 2>'),
      ]);
    });

    it('Scenario B: ETH, on the same candles, on orders, prices and balances of its own: completed at 1,997.99001 and 2,202.21001', () => {
      // As BTC's, one price.min (0.01) inside the ticker: the SELL at 1,999.99, less its fee of 1.99999, the BUY at 2,200.01, plus 2.20001.
      // Each relay names ETH's own order, price and balance, beside the currency both pairs share.
      expect(postsWith('<ETH SELL 1>', '<ETH BUY 2>')).toEqual([
        message(
          'Order Id: <ETH SELL 1>',
          'Received STICKY SELL advice for ETH/USDT',
          'Requested amount: 1',
          'At time: 2024-01-01T12:01:00.000Z',
          'Target price: 2,000 USDT',
          '------',
        ),
        message(
          'SELL STICKY order created (<ETH SELL 1>) for ETH/USDT',
          'Requested amount: 1',
          'Current symbol portfolio: 100 ETH / 300,000 USDT',
          'Target price: 2,000 USDT',
          'At time: 2024-01-01T12:01:00.000Z',
          '------',
        ),
        message(
          'Order Id: <ETH BUY 2>',
          'Received STICKY BUY advice for ETH/USDT',
          'Requested amount: 1',
          'At time: 2024-01-01T12:02:00.000Z',
          'Target price: 2,200 USDT',
          '------',
        ),
        message(
          'BUY STICKY order created (<ETH BUY 2>) for ETH/USDT',
          'Requested amount: 1',
          'Current symbol portfolio: 100 ETH / 300,000 USDT',
          'Target price: 2,200 USDT',
          'At time: 2024-01-01T12:02:00.000Z',
          '------',
        ),
        message(
          'SELL STICKY order completed (<ETH SELL 1>) for ETH/USDT',
          'Amount: 1 ETH',
          'Price: 1,997.99001 USDT',
          'Fee percent: 0.1%',
          'Fee: 1.99999 USDT',
          'At time: 2024-01-01T12:02:00.000Z',
          'Current portfolio: 99 ETH / 302,097.79011 USDT',
          '------',
        ),
        strategyLog('2024-01-01T12:03:00.000Z', 'Order Completed: <ETH SELL 1>'),
        message(
          'BUY STICKY order completed (<ETH BUY 2>) for ETH/USDT',
          'Amount: 1 ETH',
          'Price: 2,202.21001 USDT',
          'Fee percent: 0.1%',
          'Fee: 2.20001 USDT',
          'At time: 2024-01-01T12:03:00.000Z',
          'Current portfolio: 100 ETH / 299,785.37 USDT',
          '------',
        ),
        strategyLog('2024-01-01T12:04:00.000Z', 'Order Completed: <ETH BUY 2>'),
      ]);
    });

    it('Scenario C: the 10 orders advised created under the ids of their advices, the 6 filled completed under them, in order', () => {
      // Advised on each of the 5 candles, BTC's order then ETH's, each filled by the next candle and reported with the one after: those of
      // the last two candles are not reported yet. The strategy hears of a completion as it is reported, and its line goes out with the
      // next candle.
      expect({
        created: relays(' order created ('),
        completed: relays(' order completed ('),
        heard: relays('Order Completed: '),
      }).toEqual({
        created: [
          'SELL STICKY order created (<BTC SELL 1>) for BTC/USDT',
          'SELL STICKY order created (<ETH SELL 1>) for ETH/USDT',
          'BUY STICKY order created (<BTC BUY 2>) for BTC/USDT',
          'BUY STICKY order created (<ETH BUY 2>) for ETH/USDT',
          'SELL STICKY order created (<BTC SELL 3>) for BTC/USDT',
          'SELL STICKY order created (<ETH SELL 3>) for ETH/USDT',
          'BUY STICKY order created (<BTC BUY 4>) for BTC/USDT',
          'BUY STICKY order created (<ETH BUY 4>) for ETH/USDT',
          'SELL STICKY order created (<BTC SELL 5>) for BTC/USDT',
          'SELL STICKY order created (<ETH SELL 5>) for ETH/USDT',
        ],
        completed: [
          'SELL STICKY order completed (<BTC SELL 1>) for BTC/USDT',
          'SELL STICKY order completed (<ETH SELL 1>) for ETH/USDT',
          'BUY STICKY order completed (<BTC BUY 2>) for BTC/USDT',
          'BUY STICKY order completed (<ETH BUY 2>) for ETH/USDT',
          'SELL STICKY order completed (<BTC SELL 3>) for BTC/USDT',
          'SELL STICKY order completed (<ETH SELL 3>) for ETH/USDT',
        ],
        heard: [
          'Order Completed: <BTC SELL 1>',
          'Order Completed: <ETH SELL 1>',
          'Order Completed: <BTC BUY 2>',
          'Order Completed: <ETH BUY 2>',
        ],
      });
    });

    it('Scenario D: the 14 info lines the strategy logged relayed, its 10 debug lines logged and never relayed', () => {
      // A line logged on a candle goes out with that candle's notifications; one logged on an order event, delivered after them, with the
      // next candle's. Each is dated with the close of the candle being processed. The debug lines, one per pair and candle, reach the
      // logs at GEKKO_LOG_LEVEL=debug, never the chat.
      expect({ relayed: postsWith('] (strategy)\n'), debug: linesOf('STRATEGY', 'debug') }).toEqual({
        relayed: [
          strategyLog('2024-01-01T12:01:00.000Z', 'Trigger SHORT for BTC/USDT'),
          strategyLog('2024-01-01T12:01:00.000Z', 'Trigger SHORT for ETH/USDT'),
          strategyLog('2024-01-01T12:02:00.000Z', 'Trigger LONG for BTC/USDT'),
          strategyLog('2024-01-01T12:02:00.000Z', 'Trigger LONG for ETH/USDT'),
          strategyLog('2024-01-01T12:03:00.000Z', 'Trigger SHORT for BTC/USDT'),
          strategyLog('2024-01-01T12:03:00.000Z', 'Trigger SHORT for ETH/USDT'),
          strategyLog('2024-01-01T12:03:00.000Z', 'Order Completed: <BTC SELL 1>'),
          strategyLog('2024-01-01T12:03:00.000Z', 'Order Completed: <ETH SELL 1>'),
          strategyLog('2024-01-01T12:04:00.000Z', 'Trigger LONG for BTC/USDT'),
          strategyLog('2024-01-01T12:04:00.000Z', 'Trigger LONG for ETH/USDT'),
          strategyLog('2024-01-01T12:04:00.000Z', 'Order Completed: <BTC BUY 2>'),
          strategyLog('2024-01-01T12:04:00.000Z', 'Order Completed: <ETH BUY 2>'),
          strategyLog('2024-01-01T12:05:00.000Z', 'Trigger SHORT for BTC/USDT'),
          strategyLog('2024-01-01T12:05:00.000Z', 'Trigger SHORT for ETH/USDT'),
        ],
        debug: [0, 1, 2, 3, 4].flatMap(candle => [`Iteration: ${candle} for BTC/USDT`, `Iteration: ${candle} for ETH/USDT`]),
      });
    });
  });

  describe('a run each', () => {
    beforeEach(() => setUpRun());

    // A realtime run never ends by itself: each test ends its own, plugins finalised and orders stopped, before the next one starts. What a
    // test patched is restored after its run has ended, so that the orders still pending are not created after all.
    afterEach(async () => {
      try {
        await endRealtimeRun();
      } finally {
        mock.restore();
      }
    });

    it('Scenario E: resting orders canceled unfilled by the strategy a candle after their advice: 6 canceled, none completed', async () => {
      // Both pairs close at 100 on the candles DebugAdvice sells on and 90 on those it buys on: the next candle never reaches an order,
      // which rests until the strategy cancels it, a candle after its advice (cancelAfter: 1). The paper exchange cancels it at once, and
      // the Trader reports it with the same candle, when the strategy hears of it: its line goes out with the next candle. The scenario's
      // cancellations used to come from the synthetic ticker running ahead of the candles: on a flat market it canceled nothing.
      MockCCXTExchange.setPredefinedCandles('BTC/USDT', zigzag(100, 90));
      MockCCXTExchange.setPredefinedCandles('ETH/USDT', zigzag(100, 90));
      mockStrategyConfig = { ...DEFAULT_MOCK_STRATEGY_CONFIG, cancelAfter: 1 };
      // Polled every 25 s rather than every 20 s, the default: at 20 s, an order placed on a tick is polled again on the next tick, its
      // third poll, once the candle that tick fetched has moved the ticker, and the poll moves it to that candle's close, which the
      // candle then fills before the strategy can cancel it. At 25 s, its polls before the next tick fall between the two.
      mockOrderSynchInterval = 25 * ONE_SECOND;

      // Until the strategy's lines on the cancellation of the BUYs advised on the second candle have gone out, with the fourth
      await runRealtimeUntil(() => relays('Order Canceled: ').length === 4, { maxMinutes: 6 });

      expect({
        firstOrder: postsWith('<BTC SELL 1>'),
        requested: relays('Strategy requested order cancellation'),
        canceled: relays(' order canceled ('),
        heard: relays('Order Canceled: '),
        completed: relays(' order completed ('),
      }).toEqual({
        firstOrder: [
          message(
            'Order Id: <BTC SELL 1>',
            'Received STICKY SELL advice for BTC/USDT',
            'Requested amount: 1',
            'At time: 2024-01-01T12:01:00.000Z',
            'Target price: 100 USDT',
            '------',
          ),
          message(
            'SELL STICKY order created (<BTC SELL 1>) for BTC/USDT',
            'Requested amount: 1',
            'Current symbol portfolio: 100 BTC / 300,000 USDT',
            'Target price: 100 USDT',
            'At time: 2024-01-01T12:01:00.000Z',
            '------',
          ),
          strategyLog('2024-01-01T12:02:00.000Z', 'Cancelling order <BTC SELL 1> at index 1'),
          // Dated when the request reached the subscriber, at the tick: its payload is the id alone
          message('Strategy requested order cancellation', 'Order Id: <BTC SELL 1>', 'At time: 2024-01-01T12:02:02.000Z'),
          message(
            'SELL STICKY order canceled (<BTC SELL 1>) for BTC/USDT',
            'At time: 2024-01-01T12:02:00.000Z',
            'Filled amount: 0 / 1 BTC',
            'Remaining amount: 1 BTC',
            'Current price: 90 USDT',
            '------',
          ),
          strategyLog('2024-01-01T12:02:00.000Z', 'Order Canceled: <BTC SELL 1>'),
        ],
        requested: [
          'Order Id: <BTC SELL 1>',
          'Order Id: <ETH SELL 1>',
          'Order Id: <BTC BUY 2>',
          'Order Id: <ETH BUY 2>',
          'Order Id: <BTC SELL 3>',
          'Order Id: <ETH SELL 3>',
        ],
        canceled: [
          'SELL STICKY order canceled (<BTC SELL 1>) for BTC/USDT',
          'SELL STICKY order canceled (<ETH SELL 1>) for ETH/USDT',
          'BUY STICKY order canceled (<BTC BUY 2>) for BTC/USDT',
          'BUY STICKY order canceled (<ETH BUY 2>) for ETH/USDT',
          'SELL STICKY order canceled (<BTC SELL 3>) for BTC/USDT',
          'SELL STICKY order canceled (<ETH SELL 3>) for ETH/USDT',
        ],
        heard: [
          'Order Canceled: <BTC SELL 1>',
          'Order Canceled: <ETH SELL 1>',
          'Order Canceled: <BTC BUY 2>',
          'Order Canceled: <ETH BUY 2>',
        ],
        completed: [],
      });
    });

    it('Scenario F: creations failing: 4 errors notified, BTC ones lost on the network as maybe live, the breaker at the 5th', async () => {
      MockCCXTExchange.setPredefinedCandles('BTC/USDT', zigzag(100, 110));
      MockCCXTExchange.setPredefinedCandles('ETH/USDT', zigzag(2000, 2200));
      // The creations fail as an exchange answers, within the minute: those asked with a candle when the next one reaches the simulated
      // exchange, before the plugins process it. Nothing on that path waits for a timer, so one turn of the event loop lets the creations
      // of the candle before arrive, and another their failures reach the Trader: each candle's failures are delivered with the next one.
      // BTC's are lost on the network, which leaves their outcome unknown; ETH's fail on an error that placed nothing.
      const { DummyCentralizedExchange } = await import('@services/exchange/dummy/dummyCentralizedExchange');
      const { processOneMinuteBucket } = DummyCentralizedExchange.prototype;
      const pendingFailures: (() => void)[] = [];
      const nextTurn = () => new Promise(resolve => setImmediate(resolve));
      spyOn(DummyCentralizedExchange.prototype, 'createLimitOrder').mockImplementation(symbol => {
        const failure = symbol === 'BTC/USDT' ? new ExchangeNetworkError('Simulated Network Error') : new Error('Simulated Exchange Error');
        return new Promise<never>((_, reject) => pendingFailures.push(() => reject(failure)));
      });
      spyOn(DummyCentralizedExchange.prototype, 'processOneMinuteBucket').mockImplementation(async function (
        this: DummyCentralizedExchange,
        bucket,
      ) {
        await nextTurn();
        for (const fail of pendingFailures.splice(0)) fail();
        await nextTurn();
        return processOneMinuteBucket.call(this, bucket);
      });

      // The breaker ends the run, waited for rather than raced against a timer
      const failure = await runRealtimeUntilEnd({ maxMinutes: 10 });

      // The orders of each candle error with the next one, and the strategy's lines go out a candle later: 12:00's orders error with the
      // candle of 12:01, 12:01's with 12:02's. The 5th error, that of <BTC SELL 3>, delivered with the candle of 12:03, trips the breaker
      // (maxConsecutiveErrors, 5 by default) once the strategy has heard of it: what that candle queued is dropped as the run stops, the
      // strategy's line for the 5th error and the 6th error among them.
      expect({
        failure,
        errored: postsWith(' order errored ('),
        heard: relays('Order Errored: '),
        stop: linesOf('STREAM', 'warn'),
      }).toEqual({
        // The pipeline rejects with the ApplicationStopError itself, not a premature close, so that main() exits with 0
        failure: new ApplicationStopError('strategy', 'Max consecutive order errors reached (5)'),
        errored: [
          message(
            'SELL STICKY order errored (<BTC SELL 1>) for BTC/USDT',
            `Due to ${OUTCOME_UNKNOWN}`,
            'It may still be live on the exchange, where Gekko follows it no more: check it there',
            'At time: 2024-01-01T12:01:00.000Z',
            'Requested amount: 1',
            'Current price: 110 USDT',
            '------',
          ),
          message(
            'SELL STICKY order errored (<ETH SELL 1>) for ETH/USDT',
            'Due to Simulated Exchange Error',
            'At time: 2024-01-01T12:01:00.000Z',
            'Requested amount: 1',
            'Current price: 2,200 USDT',
            '------',
          ),
          message(
            'BUY STICKY order errored (<BTC BUY 2>) for BTC/USDT',
            `Due to ${OUTCOME_UNKNOWN}`,
            'It may still be live on the exchange, where Gekko follows it no more: check it there',
            'At time: 2024-01-01T12:02:00.000Z',
            'Requested amount: 1',
            'Current price: 100 USDT',
            '------',
          ),
          message(
            'BUY STICKY order errored (<ETH BUY 2>) for ETH/USDT',
            'Due to Simulated Exchange Error',
            'At time: 2024-01-01T12:02:00.000Z',
            'Requested amount: 1',
            'Current price: 2,000 USDT',
            '------',
          ),
        ],
        heard: ['Order Errored: <BTC SELL 1>', 'Order Errored: <ETH SELL 1>', 'Order Errored: <BTC BUY 2>', 'Order Errored: <ETH BUY 2>'],
        stop: [
          'Application stopped gracefully: [STRATEGY] Max consecutive order errors reached (5)',
          [
            'Deferred events dropped as the application closes, the final reports may miss them:',
            'TradingAdvisor (strategyInfo: 1), Trader (portfolioChange: 1, orderErrored: 1, orderInitiated: 2)',
          ].join(' '),
        ],
      });
    });

    it('Scenario G: no ETH candle in the first 2 live minutes: one warning at the first drop, 2 dropped, start on 12:02', async () => {
      // The exchange has no ETH candle for 12:00 and 12:01, and with no warmup the gap filler has no earlier ETH candle to fill those
      // buckets with: they are dropped until ETH has one, instead of reaching the TradingAdvisor without ETH, which threw. Computed from
      // the minute the pipeline reads as the minute in progress, the fake clock still where the test set it.
      const firstMinute = minuteOf(Date.now());
      MockCCXTExchange.simulatedGaps = { 'ETH/USDT': [{ start: firstMinute, end: firstMinute + 2 * ONE_MINUTE }] };

      // Rejected, and so failing the test, if a bucket without ETH reached the TradingAdvisor
      await runRealtimeUntil(() => findTextLine('Iteration: 0 for ETH/USDT') !== undefined, { maxMinutes: 5 });

      // ETH's live stream finds no closed candle at the ticks of 12:01:02 and 12:02:02, the exchange's first, 12:02, still in progress at
      // the second, and delivers it at 12:03:02: then the buckets of 12:00 and 12:01, BTC's alone, reach the gap filler, which warns of
      // the pair never seen at the first drop, not at the second, and sums the drops up at the first minute it pushes.
      expect({
        warnings: linesOf('STREAM', 'warn'),
        start: findTextLine('Strategy warmup done')?.message,
        firstCandle: linesOf('STRATEGY', 'debug'),
      }).toEqual({
        warnings: [
          'Received undefined candle for ETH/USDT @ 2024-01-01T12:00:00.000Z',
          'Received undefined candle for ETH/USDT @ 2024-01-01T12:00:00.000Z',
          'No ETH/USDT candle at 2024-01-01T12:00:00.000Z: dropping the leading buckets until every pair has a candle',
          [
            'Every pair has had a candle by 2024-01-01T12:02:00.000Z, the first minute pushed:',
            '2 leading minutes dropped, so the warmup will end later than planned',
          ].join(' '),
        ],
        start: 'Strategy warmup done ! Sending first candle bucket (2024-01-01T12:02:00.000Z) to strategy',
        firstCandle: ['Iteration: 0 for BTC/USDT', 'Iteration: 0 for ETH/USDT'],
      });
    });
  });
});
