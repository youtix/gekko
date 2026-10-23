import { ONE_MINUTE, ONE_SECOND } from '@gekko/shared/constants/time.const';
import { ApplicationStopError } from '@gekko/shared/errors/applicationStop.error';
import type { LogLevel } from '@gekko/shared/models/logLevel.types';
import type { Tag } from '@gekko/shared/models/tag.types';
import type { traderSchema } from '@gekko/schemas/plugins/trader.schema';
import type { DummyCentralizedExchange } from '@gekko/core/exchange/dummy/dummyCentralizedExchange';
import { ExchangeNetworkError } from '@gekko/core/exchange/exchange.error';
import type { DebugAdviceParams } from '@gekko/strategies/debug/debugAdvice.types';
import type { debugOrderScriptStrategySchema } from '@gekko/schemas/strategies/debug/debugOrderScript.schema';
import type { debugPositionBookStrategySchema } from '@gekko/schemas/strategies/debug/debugPositionBook.schema';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { z } from 'zod';
import { minuteOf, REALTIME_START, startFakeClock } from '../../helpers/clock.helper';
import { paperExchange } from '../../helpers/configuration.helper';
import {
  endRealtimeRun,
  mockRealtimeModules,
  runRealtimeUntil,
  runRealtimeUntilEnd,
  useRealtimeConfiguration,
} from '../../helpers/realtimeRun.helper';
import { MockCCXTExchange } from '../../mocks/ccxt.mock';
import { MockFetcherService, SUBSCRIBE_ALL_UPDATES } from '../../mocks/fetcher.mock';
import { clearLogs, findTextLine, isTextLine, loggedReport, loggedRoundTrips, logStore, ORDER_ID } from '../../mocks/winston.mock';

// --------------------------------------------------------------------------
// MOCKS SETUP
// --------------------------------------------------------------------------

// DebugAdvice advises on every candle (each: 1), on every pair: a STICKY SELL of 1 unit, then a BUY, and so on
const DEFAULT_MOCK_STRATEGY_CONFIG: { name: string } & Partial<DebugAdviceParams> = { name: 'DebugAdvice', each: 1 };

/** The block of DebugOrderScript, which creates these orders on the first pair on their candles, counted from 0 */
type OrderScript = { name: 'DebugOrderScript'; orders: z.input<typeof debugOrderScriptStrategySchema>['orders'] };

/**
 * The block of DebugPositionBook, which plays these steps on their candles, counted from 0: a MARKET BUY of each pair of a step, sized
 * by its position book, or an all-in MARKET SELL of each
 */
type PositionBookSteps = { name: 'DebugPositionBook'; steps: z.input<typeof debugPositionBookStrategySchema>['steps'] };

/** What the paper account holds at start-up of each asset and of the currency, unless a run sets its own */
const DEFAULT_BALANCES = { BTC: 100, ETH: 100, USDT: 300000 };

const TELEGRAM_TOKEN = 'test-token';
const TELEGRAM_USERNAME = 'test-bot';

// 1. Mock winston, ccxt and the fetcher. Each run goes on real minutes under the fake clock, and is ended before the next one starts
// (see realtimeRun.helper)
mockRealtimeModules();
// The flows read the strategy's debug lines from the winston mock: the logger hands a debug line to winston only when
// GEKKO_LOG_LEVEL lets it through, and the logger is loaded after this, by the pipeline
process.env.GEKKO_LOG_LEVEL = 'debug';

// 2. Configuration, which each run reads as it starts (see useRealtimeConfiguration)
let mockStrategyConfig: typeof DEFAULT_MOCK_STRATEGY_CONFIG | OrderScript | PositionBookSteps = DEFAULT_MOCK_STRATEGY_CONFIG;
// The options of the Trader: none, unless a run sets some
let mockTraderOptions: Omit<z.input<typeof traderSchema>, 'name'> = {};
// Left out, the defaults of the schema
let mockOrderSynchInterval: number | undefined;
let mockExchangeSynchInterval: number | undefined;
let mockBalances: typeof DEFAULT_BALANCES = DEFAULT_BALANCES;
// None, unless a run sets one: configured after the Trader, whose order events it hears in the same delivery
let mockAnalyzer: 'RoundTripAnalyzer' | undefined;
useRealtimeConfiguration(() => ({
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
      { assetName: 'BTC', balance: mockBalances.BTC },
      { assetName: 'ETH', balance: mockBalances.ETH },
      { assetName: 'USDT', balance: mockBalances.USDT },
    ]),
    orderSynchInterval: mockOrderSynchInterval,
    exchangeSynchInterval: mockExchangeSynchInterval,
  },
  plugins: [
    { name: 'TradingAdvisor', strategyName: mockStrategyConfig.name },
    { name: 'Trader', ...mockTraderOptions },
    ...(mockAnalyzer ? [{ name: mockAnalyzer }] : []),
    { name: 'EventSubscriber', token: TELEGRAM_TOKEN, botUsername: TELEGRAM_USERNAME },
  ],
  strategy: mockStrategyConfig,
}));

// --------------------------------------------------------------------------
// HELPERS
// --------------------------------------------------------------------------

/** A command the chat sends the bot once subscribed, which Telegram holds from `at` on */
type Command = { at: EpochTimeStamp; text: string };

/** The commands the chat sends after the /subscribe_all of the bot's first poll, oldest first: none, unless a run sets some */
let commands: Command[] = [];

/** The /subscribe_all of chat 123 that the bot's first poll gets: the commands after it come from that chat, numbered after it */
const [SUBSCRIBE_ALL] = SUBSCRIBE_ALL_UPDATES.result;

/**
 * Telegram's answer to a poll after the first: the commands sent by now, from the update the offset names on. The bot confirms the
 * updates it got with the offset of its next poll, so that each command is handled once, by the first poll from its time on, the bot
 * polling every second.
 */
const laterUpdates = (url: string) => {
  const offset = Number(new URL(url).searchParams.get('offset'));
  const result = commands.flatMap(({ at, text }, index) => {
    const id = SUBSCRIBE_ALL.update_id + 1 + index;
    if (at > Date.now() || id < offset) return [];
    return [{ update_id: id, message: { ...SUBSCRIBE_ALL.message, message_id: id, date: Math.floor(at / ONE_SECOND), text } }];
  });
  return { ok: true, result };
};

/**
 * Sets up a run: the logs, the posts and the ccxt mock as at load, the strategy, the Trader, the synchronization periods, the balances
 * and the analyzer of the configuration back to their defaults, no command after the subscription, and the fake clock started at
 * REALTIME_START (see clock.helper). The chat subscribes to every notification with the command the bot's first poll gets, then sends
 * the commands a run sets; an unbound bot first drops what was queued before start-up (offset=-1), here nothing.
 */
const setUpRun = () => {
  clearLogs();
  MockFetcherService.reset();
  commands = [];
  let polls = 0;
  MockFetcherService.when('getUpdates').thenReturn((url: string) => {
    if (url.includes('offset=-1')) return { ok: true, result: [] };
    return ++polls === 1 ? SUBSCRIBE_ALL_UPDATES : laterUpdates(url);
  });
  MockCCXTExchange.reset();
  mockStrategyConfig = DEFAULT_MOCK_STRATEGY_CONFIG;
  mockTraderOptions = {};
  mockOrderSynchInterval = undefined;
  mockExchangeSynchInterval = undefined;
  mockBalances = DEFAULT_BALANCES;
  mockAnalyzer = undefined;
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

/**
 * What the bot posted in the second each command of the run was sent in, oldest first, with when it posted it: the answer, which the
 * poll that gets the command sends at once. The notifications go out with the buckets, at the ticks, two seconds into a minute: a
 * command sent in another second gets its answer alone.
 */
const answers = () =>
  commands.flatMap(({ at }) =>
    MockFetcherService.callHistory
      .filter(({ method, timestamp }) => method === 'POST' && timestamp >= at && timestamp < at + ONE_SECOND)
      .map(({ timestamp, payload }) => ({ at: new Date(timestamp).toISOString(), text: payload.text })),
  );

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
  // Scenarios A-D and H read one run, which the hooks of their own describe set up and end, rather than hooks shared with E-G: Bun runs
  // a nested beforeAll before the beforeEach of an enclosing describe, which would set up the next run over it, and the enclosing
  // afterEach would end the run after the first test.
  describe('one run of 5 candles: on each, DebugAdvice advises BTC and ETH, and every order fills on the next candle', () => {
    beforeAll(async () => {
      setUpRun();
      // BTC closes at 100 on the candles DebugAdvice sells on, 110 on those it buys on; ETH at 2000 and 2200
      MockCCXTExchange.setPredefinedCandles('BTC/USDT', zigzag(100, 110));
      MockCCXTExchange.setPredefinedCandles('ETH/USDT', zigzag(2000, 2200));
      // The chat asks for the portfolio at the poll after its /subscribe_all, before the first candle, then ten seconds after the ticks
      // that bring the second candle and the fifth, the last before the clock stops (Scenario H)
      commands = [
        { at: REALTIME_START + ONE_SECOND, text: '/portfolio' },
        { at: Date.UTC(2024, 0, 1, 12, 2, 12), text: '/portfolio' },
        { at: Date.UTC(2024, 0, 1, 12, 5, 12), text: '/portfolio' },
      ];
      // The candles of 12:00 to 12:04, one a minute from 12:01:02: until the strategy's lines on the completion of the SELLs advised on
      // the third candle have gone out, with the fifth, at 12:05:02. Checked at the end of each minute of the run, the condition holds
      // at 12:05:30, where the clock stops.
      await runRealtimeUntil(() => relays('Order Completed: ').length === 6, { maxMinutes: 6 });
    });

    afterAll(() => endRealtimeRun());

    it('Scenario A: 1 BTC advised to SELL at 100 then BUY at 110, filled by the next candle: completed at 99.8001 and 110.2101', () => {
      // The Trader places the STICKY SELL advised on the candle of 12:00 one price.min (0.1) under the ticker, at 99.9, which the high of
      // the next candle reaches, and the BUY advised on that one at 110.1, which the low of 12:02 reaches. A poll of the order sees it
      // filled, and the Trader reports it: it is delivered as the next candle arrives, before the plugins process it, and the strategy's
      // line, dated with the close of the candle the strategy last processed, goes out with that candle's notifications.
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
        strategyLog('2024-01-01T12:02:00.000Z', 'Order Completed: <BTC SELL 1>'),
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
        strategyLog('2024-01-01T12:03:00.000Z', 'Order Completed: <BTC BUY 2>'),
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
        strategyLog('2024-01-01T12:02:00.000Z', 'Order Completed: <ETH SELL 1>'),
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
        strategyLog('2024-01-01T12:03:00.000Z', 'Order Completed: <ETH BUY 2>'),
      ]);
    });

    it('Scenario C: the 10 orders advised created under the ids of their advices, the 6 filled completed under them, in order', () => {
      // Advised on each of the 5 candles, BTC's order then ETH's, each filled by the next candle and reported with the one after: those of
      // the last two candles are not reported yet. The strategy hears of a completion as it is reported, before the plugins process that
      // candle, and its line goes out with the same candle's notifications.
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
          'Order Completed: <BTC SELL 3>',
          'Order Completed: <ETH SELL 3>',
        ],
      });
    });

    it('Scenario D: the 16 info lines the strategy logged relayed, its 10 debug lines logged and never relayed', () => {
      // A line logged on a candle goes out with that candle's notifications. One logged on an order event goes out with them too, ahead
      // of the candle's own: the event is delivered as the candle arrives, before the plugins process it, and the line is dated with the
      // close of the candle the strategy last processed, the one before. The debug lines, one per pair and candle, reach the logs at
      // GEKKO_LOG_LEVEL=debug, never the chat.
      expect({ relayed: postsWith('] (strategy)\n'), debug: linesOf('STRATEGY', 'debug') }).toEqual({
        relayed: [
          strategyLog('2024-01-01T12:01:00.000Z', 'Trigger SHORT for BTC/USDT'),
          strategyLog('2024-01-01T12:01:00.000Z', 'Trigger SHORT for ETH/USDT'),
          strategyLog('2024-01-01T12:02:00.000Z', 'Trigger LONG for BTC/USDT'),
          strategyLog('2024-01-01T12:02:00.000Z', 'Trigger LONG for ETH/USDT'),
          strategyLog('2024-01-01T12:02:00.000Z', 'Order Completed: <BTC SELL 1>'),
          strategyLog('2024-01-01T12:02:00.000Z', 'Order Completed: <ETH SELL 1>'),
          strategyLog('2024-01-01T12:03:00.000Z', 'Trigger SHORT for BTC/USDT'),
          strategyLog('2024-01-01T12:03:00.000Z', 'Trigger SHORT for ETH/USDT'),
          strategyLog('2024-01-01T12:03:00.000Z', 'Order Completed: <BTC BUY 2>'),
          strategyLog('2024-01-01T12:03:00.000Z', 'Order Completed: <ETH BUY 2>'),
          strategyLog('2024-01-01T12:04:00.000Z', 'Trigger LONG for BTC/USDT'),
          strategyLog('2024-01-01T12:04:00.000Z', 'Trigger LONG for ETH/USDT'),
          strategyLog('2024-01-01T12:04:00.000Z', 'Order Completed: <BTC SELL 3>'),
          strategyLog('2024-01-01T12:04:00.000Z', 'Order Completed: <ETH SELL 3>'),
          strategyLog('2024-01-01T12:05:00.000Z', 'Trigger SHORT for BTC/USDT'),
          strategyLog('2024-01-01T12:05:00.000Z', 'Trigger SHORT for ETH/USDT'),
        ],
        debug: [0, 1, 2, 3, 4].flatMap(candle => [`Iteration: ${candle} for BTC/USDT`, `Iteration: ${candle} for ETH/USDT`]),
      });
    });

    it('Scenario H: /portfolio answered at once: nothing yet, then the balances last read, 70 s then 50 s before, and their value', () => {
      // Each answer dates the balances with the time the Trader read them, which every order event says, and the prices with the close of
      // the last bucket.
      // 12:00:31: the Trader read the account as it started, at 12:00:30, but what it queues waits for the first bucket, at 12:01:02: the
      // subscriber has received neither a balance nor a price.
      // 12:02:12: it holds the balances the Trader read at 12:01:02 as the warmup ended, before the SELLs advised on the first candle were
      // placed, which the creations of those SELLs brought with the first bucket: 100 BTC, 100 ETH and 300,000 USDT, all free, read 1
      // minute 10 seconds before the poll. The BUYs created at 12:02:02 carry that same read, with its time; the SELLs, filled by the
      // bucket of 12:02:02, are read at 12:02:22.
      // The closes of the candle of 12:01, a candle DebugAdvice buys on: 300,000 + 100 × 110 + 100 × 2,200 = 531,000 USDT in all.
      // 12:05:12: it holds the balances the Trader read at 12:04:22, once the polls of the SELLs advised on the third candle had seen them
      // filled: their ends brought them as the bucket of 12:05:02 arrived, 40 seconds after the read and 10 before the poll, and the
      // creations of the SELLs advised on the fifth candle brought them again. 99 BTC and 99 ETH: of the 100 of each, 1 sold on the first
      // candle, 1 bought on the second, 1 sold on the third. 301,883.16011 USDT: 300,000, plus the proceeds of the SELLs,
      // 2 × (99.8001 + 1,997.99001), less the cost of the BUYs of the second candle, 110.2101 + 2,202.21001 (see Scenarios A and B). The
      // BUYs advised on the fourth, open then, reserve their cost at the same prices, fee included, 2,312.42011, which leaves 299,570.74
      // free. The bucket of 12:05:02 filled them, and the SELLs advised on the fifth candle reserve 1 of each asset: the Trader reads that
      // at 12:05:22, which the subscriber would receive with the next bucket, after the run. The closes of the candle of 12:04, a candle
      // DebugAdvice sells on: 301,883.16011 + 99 × 100 + 99 × 2,000 = 509,783.16011 USDT in all.
      expect(answers()).toEqual([
        {
          at: '2024-01-01T12:00:31.000Z',
          text: message(
            'No balance received from the Trader yet (no Trader configured, or its first read still on its way)',
            'No price yet: no 1-minute candle has been processed',
          ),
        },
        {
          at: '2024-01-01T12:02:12.000Z',
          text: message(
            'Balances read by the Trader at 2024-01-01T12:01:02.000Z (1 minute 10 seconds ago)',
            'BTC: 100 (free 100, used 0)',
            'ETH: 100 (free 100, used 0)',
            'USDT: 300,000 (free 300,000, used 0)',
            'Prices at the close of 2024-01-01T12:02:00.000Z',
            'BTC/USDT: 110 USDT',
            'ETH/USDT: 2,200 USDT',
            'Total value: 531,000 USDT',
          ),
        },
        {
          at: '2024-01-01T12:05:12.000Z',
          text: message(
            'Balances read by the Trader at 2024-01-01T12:04:22.000Z (50 seconds ago)',
            'BTC: 99 (free 99, used 0)',
            'ETH: 99 (free 99, used 0)',
            'USDT: 301,883.16011 (free 299,570.74, used 2,312.42011)',
            'Prices at the close of 2024-01-01T12:05:00.000Z',
            'BTC/USDT: 100 USDT',
            'ETH/USDT: 2,000 USDT',
            'Total value: 509,783.16011 USDT',
          ),
        },
      ]);
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
      // the Trader reports it with the same candle, when the strategy hears of it: its line goes out as the next candle arrives, before the
      // plugins process it. The scenario's cancellations used to come from the synthetic ticker running ahead of the candles: on a flat
      // market it canceled nothing.
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
        requestedFor: postsWith('Strategy requested order cancellation').map(text => text.split('\n')[0]),
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
          // Dated when the request reached the subscriber, at the tick: its payload names the order and its pair, not when it was asked
          message('Strategy requested order cancellation for BTC/USDT', 'Order Id: <BTC SELL 1>', 'At time: 2024-01-01T12:02:02.000Z'),
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
        // The first line of each of those requests, which names the pair of its order: BTC's, then ETH's, on each candle
        requestedFor: [
          'Strategy requested order cancellation for BTC/USDT',
          'Strategy requested order cancellation for ETH/USDT',
          'Strategy requested order cancellation for BTC/USDT',
          'Strategy requested order cancellation for ETH/USDT',
          'Strategy requested order cancellation for BTC/USDT',
          'Strategy requested order cancellation for ETH/USDT',
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
      // of the candle before arrive, and another their failures reach the Trader: each candle's failures are delivered with the next one,
      // before the plugins process it.
      // BTC's are lost on the network, which leaves their outcome unknown; ETH's fail on an error that placed nothing.
      const { DummyCentralizedExchange } = await import('@gekko/core/exchange/dummy/dummyCentralizedExchange');
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

      // The orders of each candle error with the next one, the strategy's lines going out with it: 12:00's orders error with the candle
      // of 12:01, 12:01's with 12:02's. Each notification quotes the last close the subscriber has processed, that of the candle its order
      // was advised on. The 5th error, that of <BTC SELL 3>, delivered as the candle of 12:03 arrives, trips the breaker
      // (maxConsecutiveErrors, 5 by default) once the strategy has heard of it, before the plugins process that candle, which advises
      // nothing: what was queued since is dropped as the run stops, the strategy's line for the 5th error and the 6th error among them.
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
            'Current price: 100 USDT',
            '------',
          ),
          message(
            'SELL STICKY order errored (<ETH SELL 1>) for ETH/USDT',
            'Due to Simulated Exchange Error',
            'At time: 2024-01-01T12:01:00.000Z',
            'Requested amount: 1',
            'Current price: 2,000 USDT',
            '------',
          ),
          message(
            'BUY STICKY order errored (<BTC BUY 2>) for BTC/USDT',
            `Due to ${OUTCOME_UNKNOWN}`,
            'It may still be live on the exchange, where Gekko follows it no more: check it there',
            'At time: 2024-01-01T12:02:00.000Z',
            'Requested amount: 1',
            'Current price: 110 USDT',
            '------',
          ),
          message(
            'BUY STICKY order errored (<ETH BUY 2>) for ETH/USDT',
            'Due to Simulated Exchange Error',
            'At time: 2024-01-01T12:02:00.000Z',
            'Requested amount: 1',
            'Current price: 2,200 USDT',
            '------',
          ),
        ],
        heard: ['Order Errored: <BTC SELL 1>', 'Order Errored: <ETH SELL 1>', 'Order Errored: <BTC BUY 2>', 'Order Errored: <ETH BUY 2>'],
        stop: [
          'Application stopped gracefully: [STRATEGY] Max consecutive order errors reached (5)',
          [
            'Deferred events dropped as the application closes, the final reports may miss them:',
            'TradingAdvisor (strategyInfo: 1), Trader (portfolioChange: 1, orderErrored: 1)',
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

    it('Scenario I: /portfolio dated with the reads the order events bring, those held back from the portfolio changes too', async () => {
      // BTC closes at 100 on the even candles and 110 on the odd ones, as in Scenarios A-D: the STICKY SELL DebugOrderScript creates on
      // candle 0 fills on candle 1, its BUY of candle 1 on candle 2. ETH trades nothing.
      MockCCXTExchange.setPredefinedCandles('BTC/USDT', zigzag(100, 110));
      MockCCXTExchange.setPredefinedCandles('ETH/USDT', zigzag(2000, 2200));
      mockStrategyConfig = {
        name: 'DebugOrderScript',
        orders: [
          { candle: 0, side: 'SELL', type: 'STICKY' },
          { candle: 1, side: 'BUY', type: 'STICKY' },
        ],
      };
      // The Trader emits its first read alone as a portfolio change, at 12:00:30: no later one moves a total by more than 50 %
      mockTraderOptions = { portfolioUpdates: { threshold: 50, dust: 0 } };
      // It reads the account every 30 s besides, from 12:01:00 on
      mockExchangeSynchInterval = 30 * ONE_SECOND;
      // Ten seconds after the tick that creates the BUY, then after the one that brings the end of the SELL
      commands = [
        { at: Date.UTC(2024, 0, 1, 12, 2, 12), text: '/portfolio' },
        { at: Date.UTC(2024, 0, 1, 12, 3, 12), text: '/portfolio' },
      ];

      await runRealtimeUntil(() => answers().length === 2, { maxMinutes: 4 });

      // 12:02:12: the creation of the BUY, at 12:02:02, carries the Trader's last read as it stands, made at 12:02:00, which shows the SELL
      // placed at 12:01:02 holding 1 BTC: held back, no total having changed, it reaches /portfolio through that creation alone, read 12
      // seconds before the poll. The SELL, filled by the bucket of 12:02:02, is read at 12:02:22. The closes of the candle of 12:01:
      // 300,000 + 100 × 110 + 100 × 2,200 = 531,000 USDT in all.
      // 12:03:12: the end of the SELL, delivered as the bucket of 12:03:02 arrives, carries the read made once it filled, at 12:02:22, 50
      // seconds before the poll, which a change of 1 % of the BTC and of 0.03 % of the USDT kept from the portfolio changes: 99 BTC, and
      // 300,000 + 99.9 - 0.0999 = 300,099.8001 USDT, of which the BUY placed at 110.1 holds its cost and its fee, 110.1 + 0.1101 =
      // 110.2101. Nothing is created on candle 2. The closes of the candle of 12:02: 300,099.8001 + 99 × 100 + 100 × 2,000 = 509,999.8001.
      expect(answers()).toEqual([
        {
          at: '2024-01-01T12:02:12.000Z',
          text: message(
            'Balances read by the Trader at 2024-01-01T12:02:00.000Z (12 seconds ago)',
            'BTC: 100 (free 99, used 1)',
            'ETH: 100 (free 100, used 0)',
            'USDT: 300,000 (free 300,000, used 0)',
            'Prices at the close of 2024-01-01T12:02:00.000Z',
            'BTC/USDT: 110 USDT',
            'ETH/USDT: 2,200 USDT',
            'Total value: 531,000 USDT',
          ),
        },
        {
          at: '2024-01-01T12:03:12.000Z',
          text: message(
            'Balances read by the Trader at 2024-01-01T12:02:22.000Z (50 seconds ago)',
            'BTC: 99 (free 99, used 0)',
            'ETH: 100 (free 100, used 0)',
            'USDT: 300,099.8001 (free 299,989.59, used 110.2101)',
            'Prices at the close of 2024-01-01T12:03:00.000Z',
            'BTC/USDT: 100 USDT',
            'ETH/USDT: 2,000 USDT',
            'Total value: 509,999.8001 USDT',
          ),
        },
      ]);
    });

    it('Scenario J: a round trip on each pair, overlapping: each notified with the P&L of its own fills, numbered as they close', async () => {
      // DebugPositionBook trades both pairs from 20,000 USDT and nothing else: it buys ETH on candle 0, BTC on candle 1, then sells ETH on
      // candle 2 and BTC on candle 3. Each MARKET order fills as it is sent, at the close of its candle, the clock of the simulator, and its
      // end is heard as the next candle arrives, before the plugins process it: ETH is held from 12:01 to 12:03, BTC from 12:02 to 12:04,
      // two round trips that overlap without coinciding, ETH's closing first.
      // BTC closes at 1000 on the candles of 12:00 and 12:01, at 1050 on that of 12:02, which falls to 980, then at 1100 and 1200; ETH at
      // 2000, 2100, 1900, 1950 and 2000. The run processes the candles of 12:00 to 12:04.
      MockCCXTExchange.setPredefinedCandles('BTC/USDT', [
        { close: 1000 },
        { close: 1000 },
        { close: 1050, low: 980 },
        { close: 1100 },
        { close: 1200 },
      ]);
      MockCCXTExchange.setPredefinedCandles('ETH/USDT', [
        { close: 2000 },
        { close: 2100 },
        { close: 1900 },
        { close: 1950 },
        { close: 2000 },
      ]);
      mockBalances = { BTC: 0, ETH: 0, USDT: 20000 };
      mockAnalyzer = 'RoundTripAnalyzer';
      mockStrategyConfig = {
        name: 'DebugPositionBook',
        steps: [
          { candle: 0, side: 'BUY', symbols: ['ETH/USDT'] },
          { candle: 1, side: 'BUY', symbols: ['BTC/USDT'] },
          { candle: 2, side: 'SELL', symbols: ['ETH/USDT'] },
          { candle: 3, side: 'SELL', symbols: ['BTC/USDT'] },
        ],
      };

      // Until BTC's round trip closes, its SELL heard as the candle of 12:04 arrives, at 12:05:02. The run is then ended through the signal
      // of its pipeline, the plugins finalised with the AbortError as the failure that stopped it: the RoundTripAnalyzer logs its report.
      await runRealtimeUntil(() => loggedRoundTrips().length === 2, { maxMinutes: 6 });
      await endRealtimeRun();

      // The book shares the currency between the pairs not invested. On candle 0 both are flat: ETH's BUY is allocated 50 % of the 20,000
      // USDT the Trader read, 10,000, which buy 10,000 × 0.95 / 2000 = 4.75 ETH once 5 % is kept back for the fee. On candle 1 BTC is the
      // last pair not invested: its BUY goes all-in, sized from the 10,490.5 USDT the Trader read after ETH's, 10,490.5 × 0.95 / 1000 =
      // 9.965975 BTC. Each SELL sells all of its asset. The simulator takes its fee, Binance's 0.1 %, in USDT: on top of the cost of a BUY,
      // out of what a SELL brings in. 20,000 - 9500 - 9.5 - 9,965.975 - 9.965975 + 9025 - 9.025 + 10,962.5725 - 10.9625725 =
      // 20,482.1439525 USDT at the end, and nothing else.
      const at = (minutes: number) => Date.UTC(2024, 0, 1, 12, minutes);
      expect({
        notified: postsWith('Roundtrip completed for '),
        roundTrips: loggedRoundTrips(),
        report: loggedReport('TRADING REPORT'),
      }).toEqual({
        // Each round trip notified as it closes, with the P&L of its own fills and its profit, rounded down as the console rounds it
        notified: [
          message(
            'Roundtrip completed for ETH/USDT',
            'PnL: -493.525',
            'Profit: -2.47%',
            'Duration: 2 minutes',
            'Entry Price: 2,000',
            'Exit Price: 1,900',
            'Max Adverse Excursion: 5%',
            'At time: 2024-01-01T12:03:00.000Z',
            '------',
          ),
          message(
            'Roundtrip completed for BTC/USDT',
            'PnL: 975.6689525',
            'Profit: 4.76%',
            'Duration: 2 minutes',
            'Entry Price: 1,000',
            'Exit Price: 1,100',
            'Max Adverse Excursion: 2%',
            'At time: 2024-01-01T12:04:00.000Z',
            '------',
          ),
        ],
        // Numbered across the pairs in the order they close: ETH's, which BTC's overlaps, first
        roundTrips: [
          {
            id: 0,
            symbol: 'ETH/USDT',
            entryAt: at(1),
            entryPrice: 2000,
            // The whole portfolio before its BUY: after it, 4.75 ETH at its price, 2000, and the 10,490.5 USDT left, its fee of 9.5 given
            // back
            entryEquity: 20000,
            exitAt: at(3),
            exitPrice: 1900,
            // 4.75 × 2000 and 4.75 × 1900, and the fees of both, 9.5 and 9.025
            cost: 9500,
            proceeds: 9025,
            fees: 18.525,
            // 9025 - 9500 - 18.525
            pnl: -493.525,
            // -493.525 / 20,000 × 100
            profit: -2.467625,
            // (2000 - 1900) / 2000 × 100, for the low of 12:02, the last candle it holds: that of 12:01, at 2100, is above its entry
            maxAdverseExcursion: 5,
            duration: 2 * ONE_MINUTE,
          },
          {
            id: 1,
            symbol: 'BTC/USDT',
            entryAt: at(2),
            entryPrice: 1000,
            // The whole portfolio before its BUY: after it, 9.965975 BTC at its price, 1000, the 4.75 ETH at their last close, 2100, and
            // the 514.559025 USDT left, its fee of 9.965975 given back: 9,965.975 + 9975 + 514.559025 + 9.965975
            entryEquity: 20465.5,
            exitAt: at(4),
            exitPrice: 1100,
            // 9.965975 × 1000 and 9.965975 × 1100, and the fees of both, 9.965975 and 10.9625725
            cost: 9965.975,
            proceeds: 10962.5725,
            fees: 20.9285475,
            // 10,962.5725 - 9,965.975 - 20.9285475
            pnl: 975.6689525,
            // 975.6689525 / 20,465.5 × 100, to 15 significant digits
            profit: 4.76738390217683,
            // (1000 - 980) / 1000 × 100, for the low of 12:02: that of 12:03, at 1100, is above its entry
            maxAdverseExcursion: 2,
            duration: 2 * ONE_MINUTE,
          },
        ],
        report: {
          id: 'TRADING REPORT',
          // From the close of the candle that completed the warmup, 12:00's, to that of the last candle processed, 12:04's
          periodStartAt: at(1),
          periodEndAt: at(5),
          formattedDuration: '4 minutes',
          // The whole portfolio, 20,000 USDT at the start and 20,482.1439525 at the end, nothing else held then: the P&L of the two
          // round trips, 975.6689525 - 493.525
          netProfit: 482.1439525,
          // The period is shorter than a day: annualized over a day, 1/366 of the year 2024, 482.1439525 × 366
          annualizedNetProfit: 176464.686615,
          // 482.1439525 / 20,000 × 100
          totalReturnPct: 2.4107197625,
          // 2.4107197625 × 366
          annualizedReturnPct: 882.323433075,
          // BTC's, watched, the benchmark by default: from its close of 12:00, 1000, to that of 12:04, 1200
          benchmarkAsset: 'BTC',
          startPrice: 1000,
          endPrice: 1200,
          marketReturnPct: 20,
          // 2.4107197625 - 20
          alpha: -17.5892802375,
          // The union of the two round trips, 12:01 to 12:04: 3 of the 4 minutes, where added up they would fill the period
          exposurePct: 75,
          // The returns are the profits of the two round trips, -2.467625 and 4.76738390217683: their population standard deviation, half
          // the gap between them, and the root mean square of the loss over both, 2.467625 / √2
          volatility: 3.617504451088415,
          downsideDeviation: 1.7448743709254542,
          // 877.323433075, the annualized return less the risk-free 5, over each deviation × √(2 returns × 366 a year)
          sharpeRatio: 8.96386102636035,
          sortinoRatio: 18.584035448121035,
          startBalance: 20000,
          finalBalance: 20482.1439525,
          // BTC's round trip made money, ETH's lost: 1 of 2
          winRate: 50,
          topMAEs: [5, 2],
          // The four orders, each completed
          tradeCount: 4,
          // In the order of watch.assets: each pair's round trip, its two trades, its P&L, and the half of the period it was held
          pairs: [
            {
              symbol: 'BTC/USDT',
              roundTripCount: 1,
              winCount: 1,
              winRate: 100,
              tradeCount: 2,
              pnl: 975.6689525,
              exposurePct: 50,
              maxAdverseExcursion: 2,
            },
            {
              symbol: 'ETH/USDT',
              roundTripCount: 1,
              winCount: 0,
              winRate: 0,
              tradeCount: 2,
              pnl: -493.525,
              exposurePct: 50,
              maxAdverseExcursion: 5,
            },
          ],
          interruption: 'The operation was aborted',
        },
      });
    });
  });
});
