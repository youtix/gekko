import type { SQLiteStorage } from '@services/storage/sqlite.storage';
import type { DebugAdviceParams } from '@strategies/debug/debugAdvice.types';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as originalDateFns from 'date-fns';
import { endRealtimeRun, trackRealtimeRuns } from '../../helpers/realtimeRun.helper';
import { createCcxtModuleMock, MockCCXTExchange } from '../../mocks/ccxt.mock';
import { mockDateFns } from '../../mocks/date-fns.mock';
import { MockFetcherService } from '../../mocks/fetcher.mock';
import { MockHeart } from '../../mocks/heart.mock';
import { MockWinston, clearLogs, logStore } from '../../mocks/winston.mock';

// --------------------------------------------------------------------------
// MOCKS SETUP
// --------------------------------------------------------------------------

// DebugAdvice advises on every candle (each: 1), a SELL then a BUY, on every pair
const DEFAULT_MOCK_STRATEGY_CONFIG: { name: string } & Partial<DebugAdviceParams> = { name: 'DebugAdvice', each: 1 };

// For realtime mode we use accelerated time (10ms = 1 minute)
const FAST_MINUTE = 50;

// Track candles emitted
const TARGET_CANDLES = 10;

// Wait for candles to be collected (with accelerated time, this should be fast)
// We'll wait for TARGET_CANDLES * FAST_MINUTE to give buffer
const TIMEOUT_MS = TARGET_CANDLES * FAST_MINUTE;

const TELEGRAM_TOKEN = 'test-token';
const TELEGRAM_USERNAME = 'test-bot';

// 1. Mock Winston
mock.module('winston', () => MockWinston);
// The flows read the strategy's debug lines from the winston mock: the logger hands a debug line to winston only when
// GEKKO_LOG_LEVEL lets it through, and the logger is loaded after this, by the pipeline
process.env.GEKKO_LOG_LEVEL = 'debug';

// 2. Mock Time Constants
mock.module('@constants/time.const', () => ({
  ONE_SECOND: 1,
  ONE_MINUTE: FAST_MINUTE,
}));

// 3. Mock Fetcher

// Define the subscription response
const subscriptionResponse = {
  ok: true,
  result: [
    {
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 123, is_bot: false, first_name: 'Test', username: 'test' },
        chat: { id: 123, first_name: 'Test', username: 'test', type: 'private' },
        date: 1600000000,
        text: '/subscribe_all@test-bot',
      },
    },
  ],
};

mock.module('@services/fetcher/fetcher.service', () => ({
  fetcher: new MockFetcherService(),
}));

// 4. Mock Configuration
let mockPairs = [
  { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' },
  { symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT' },
];
let mockStrategyConfig = DEFAULT_MOCK_STRATEGY_CONFIG;
mock.module('@services/configuration/configuration', () => {
  return {
    config: {
      getWatch: () => ({
        mode: 'realtime',
        pairs: mockPairs,
        timeframe: '1m',
        tickrate: 100,
        warmup: { candleCount: 0, tickrate: 100 },
      }),
      showLogo: () => false,
      getExchange: () => ({
        name: 'paper-binance',
        verbose: false,
        simulationBalance: new Map([
          ['BTC', 100],
          ['ETH', 100],
          ['USDT', 300000],
        ]),
        // Set here because this mock bypasses the schema and its defaults: setInterval(fn, undefined) would fire every millisecond.
        // The trader synchronizes at start and on order events only, as in the other flows. The orders are polled every 20 ms, the
        // 20 s default at the clock of this file (ONE_SECOND = 1 ms): the paper exchange does not notify a fill, the polls find it.
        exchangeSynchInterval: 10 * 60 * 1000,
        orderSynchInterval: 20,
      }),
      getStorage: () => ({
        type: 'sqlite',
        database: ':memory:', // Isolated DB
      }),
      getPlugins: () => [
        { name: 'TradingAdvisor', strategyName: 'DebugAdvice' },
        { name: 'Trader' },
        { name: 'EventSubscriber', token: TELEGRAM_TOKEN, botUsername: TELEGRAM_USERNAME },
      ],
      getStrategy: () => mockStrategyConfig,
    },
  };
});

// 5. Mock CCXT Library
mock.module('ccxt', () => createCcxtModuleMock());

// 6. Mock date-fns
mock.module('date-fns', () => {
  return {
    ...originalDateFns,
    ...mockDateFns,
  };
});

// 7. Mock Heart
mock.module('@services/core/heart/heart', () => ({
  Heart: MockHeart,
}));

// 8. End each test's run before the next test starts (see realtimeRun.helper)
trackRealtimeRuns();

import { cleanDatabase } from '../../helpers/database.helper';

describe('E2E: Realtime Screener Flow', () => {
  beforeEach(async () => {
    // Stop all stale hearts from previous tests to prevent timer leakage
    MockHeart.stopAll();

    // Reset inject singletons
    const { inject } = await import('@services/injecter/injecter');
    inject.reset();

    // Clean DB
    const storage = inject.storage() as SQLiteStorage;
    cleanDatabase(storage);
    clearLogs();

    // Reset mocks
    MockFetcherService.reset();

    // Configure Telegram subscription response (only once, with the first poll)
    let getCallCount = 0;
    MockFetcherService.when('getUpdates').thenReturn((url: string) => {
      // An unbound bot first drops what was queued before start-up (offset=-1): nothing is queued here
      if (url.includes('offset=-1')) return { ok: true, result: [] };
      getCallCount++;
      if (getCallCount === 1) {
        return subscriptionResponse;
      }
      return { ok: true, result: [] };
    });

    // Reset MockCCXTExchange static state
    MockCCXTExchange.simulatedGaps = [];
    MockCCXTExchange.shouldThrowError = false;
    MockCCXTExchange.emitDuplicatesEveryXCandle = 0;
    MockCCXTExchange.emitFutureCandles = false;
    MockCCXTExchange.mockTrades = [];
    MockCCXTExchange.shouldThrowOnCreateOrder = false;
    MockCCXTExchange.simulateOpenOrders = false;

    // Reset config defaults
    mockStrategyConfig = DEFAULT_MOCK_STRATEGY_CONFIG;
    mockPairs = [
      { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' },
      { symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT' },
    ];
  });

  // A realtime run never ends by itself: each test ends its own, plugins finalised and orders stopped, before the next one starts
  afterEach(() => endRealtimeRun());

  it('Scenario A: Standard Screener Flow (Buy/Sell Alert)', async () => {
    // Dynamic imports
    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');

    // Get storage reference
    const storage = inject.storage() as SQLiteStorage;
    storage.close = () => {};

    // Run pipeline
    const pipelinePromise = gekkoPipeline();
    await Promise.race([pipelinePromise, new Promise<void>(resolve => setTimeout(resolve, TIMEOUT_MS))]);

    // Verify Telegram messages were sent
    // We expect at least one message for order placement (DebugAdvice advises on every candle with each: 1, a SELL then a BUY)
    const calls = MockFetcherService.callHistory.filter(c => c.method === 'POST');
    expect(calls.length).toBeGreaterThan(0);

    expect(calls.filter(call => call.payload.text.includes('BUY')).length).toBeGreaterThanOrEqual(1);
    expect(calls.filter(call => call.payload.text.includes('SELL')).length).toBeGreaterThanOrEqual(1);
  });

  it('Scenario B: Multi-Pair Signal Independence', async () => {
    // Both BTC and ETH are in default mockPairs
    // Strategy triggers every candle (each: 1)

    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');
    const storage = inject.storage() as SQLiteStorage;
    storage.close = () => {};

    const pipelinePromise = gekkoPipeline();
    await Promise.race([pipelinePromise, new Promise<void>(resolve => setTimeout(resolve, TIMEOUT_MS))]);

    const calls = MockFetcherService.callHistory.filter(c => c.method === 'POST');
    // Check we have messages for BOTH pairs
    // We expect at least one message for each pair
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(call => call.payload.text.includes('BTC/USDT')).length).toBeGreaterThan(0);
    expect(calls.filter(call => call.payload.text.includes('ETH/USDT')).length).toBeGreaterThan(0);
  });

  it('Scenario C: Strategy Creation order process', async () => {
    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');
    const storage = inject.storage() as SQLiteStorage;
    storage.close = () => {};

    const pipelinePromise = gekkoPipeline();
    await Promise.race([pipelinePromise, new Promise<void>(resolve => setTimeout(resolve, TIMEOUT_MS))]);

    const calls = MockFetcherService.callHistory.filter(c => c.method === 'POST');

    expect(calls.filter(call => call.payload.text.includes('advice')).length).toBeGreaterThanOrEqual(2);
    expect(calls.filter(call => call.payload.text.includes('order created')).length).toBeGreaterThanOrEqual(2);
    expect(calls.filter(call => call.payload.text.includes('order completed')).length).toBeGreaterThanOrEqual(2);
  });

  it('Scenario D: Strategy Info Event Subscription (Logs)', async () => {
    // Strategy triggers logs every candle
    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');
    const storage = inject.storage() as SQLiteStorage;
    storage.close = () => {};

    const pipelinePromise = gekkoPipeline();
    await Promise.race([pipelinePromise, new Promise<void>(resolve => setTimeout(resolve, TIMEOUT_MS))]);

    const calls = MockFetcherService.callHistory.filter(c => c.method === 'POST');
    expect(calls.length).toBeGreaterThan(0);

    // Look for strategy info messages: the lines DebugAdvice logs at info, its signals and order outcomes
    // EventSubscriber formats it as: "• 2026-02-07T17:24:27.000Z [INFO] (strategy)\nTrigger SHORT for BTC/USDT\n------\n"
    expect(calls.filter(call => call.payload.text.includes('[INFO] (strategy)')).length).toBeGreaterThan(5);

    // Verify content of at least one message
    const sampleMessage = calls
      .filter(call => call.payload.text.includes('[INFO] (strategy)'))
      .find(call => call.payload.text.includes('Trigger'));
    expect(sampleMessage?.payload.text).toContain('BTC/USDT');

    // Its debug lines (Iteration, on every candle) are not relayed
    expect(calls.filter(call => call.payload.text.includes('[DEBUG] (strategy)')).length).toBe(0);
  });

  it('Scenario E: Order Cancellation', async () => {
    // Enable open orders so they don't auto-fill
    MockCCXTExchange.simulateOpenOrders = true;

    // Configure strategy to cancel orders after 1 candle
    mockStrategyConfig = { ...DEFAULT_MOCK_STRATEGY_CONFIG, cancelAfter: 1 };

    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');
    const storage = inject.storage() as SQLiteStorage;
    storage.close = () => {};

    const pipelinePromise = gekkoPipeline();
    await Promise.race([pipelinePromise, new Promise<void>(resolve => setTimeout(resolve, TIMEOUT_MS))]);

    const calls = MockFetcherService.callHistory.filter(c => c.method === 'POST');
    expect(calls.length).toBeGreaterThan(0);

    // Check for Strategy Cancel Order notification
    expect(calls.filter(call => call.payload.text.includes('Strategy requested order cancellation')).length).toBeGreaterThan(0);
    expect(calls.filter(call => call.payload.text.includes('order canceled')).length).toBeGreaterThan(0);

    MockCCXTExchange.simulateOpenOrders = false;
  });

  it('Scenario G: A pair without a candle in the first live minutes', async () => {
    // The exchange has no ETH candle for the first two minutes of the run, and with no warmup the gap filler has no earlier ETH candle
    // to fill those buckets with: they are dropped until ETH has one, instead of reaching the TradingAdvisor without ETH, which threw.
    // Two minutes, so that the gap holds the first live minute even when a minute starts while the run is being built.
    const firstMinute = Math.floor(Date.now() / FAST_MINUTE) * FAST_MINUTE;
    MockCCXTExchange.simulatedGaps = { 'ETH/USDT': [{ start: firstMinute, end: firstMinute + 2 * FAST_MINUTE }] };

    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');
    const storage = inject.storage() as SQLiteStorage;
    storage.close = () => {};

    // Rejected, and so failing the test, if a bucket without ETH reached the TradingAdvisor
    const pipelinePromise = gekkoPipeline();
    await Promise.race([pipelinePromise, new Promise<void>(resolve => setTimeout(resolve, TIMEOUT_MS))]);

    // One warning per pair never seen at the first drop (the later drops are silent), then a summary at the first minute pushed
    const dropWarnings = logStore.filter(
      log => log.level === 'warn' && String(log.message).includes('dropping the leading buckets until every pair has a candle'),
    );
    expect(dropWarnings.length).toBeGreaterThan(0);
    // The strategy started once both pairs had a candle
    expect(logStore.some(log => log.message === 'Iteration: 0 for ETH/USDT')).toBe(true);
  });

  it('Scenario F: Order Error Handling', async () => {
    // The exchange refuses every order, and answers before the next candle, as a real one answers within the minute: the creations
    // asked during a bucket fail when the next bucket reaches the simulated exchange, which happens before the plugins process it.
    // Nothing on that path waits for a timer, so one turn of the event loop lets the creations of the previous bucket arrive, and
    // another their failures reach the Trader: each bucket's failures are delivered with the next bucket, whatever the load. Errors
    // 1-2 are then delivered with bucket 2 and 3-4 with bucket 3, and the strategy logs of each pair go out with the bucket after,
    // the breaker tripping on the 5th, with bucket 4, after those of 3-4 went out. On a timer instead, the failures raced the buckets:
    // on a busy machine those of several buckets reached one flush, and the logs queued in the flush where the breaker trips are
    // dropped as the run stops (PluginsStream).
    const { DummyCentralizedExchange } = await import('@services/exchange/dummy/dummyCentralizedExchange');
    const { createLimitOrder, processOneMinuteBucket } = DummyCentralizedExchange.prototype;
    const pendingFailures: (() => void)[] = [];
    const nextTurn = () => new Promise(resolve => setImmediate(resolve));
    DummyCentralizedExchange.prototype.createLimitOrder = function () {
      return new Promise<never>((_, reject) => pendingFailures.push(() => reject(new Error('Simulated Exchange Error'))));
    };
    DummyCentralizedExchange.prototype.processOneMinuteBucket = async function (bucket) {
      await nextTurn();
      for (const fail of pendingFailures.splice(0)) fail();
      await nextTurn();
      return processOneMinuteBucket.call(this, bucket);
    };

    try {
      const { ApplicationStopError } = await import('@errors/applicationStop.error');
      const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
      const { inject } = await import('@services/injecter/injecter');
      const storage = inject.storage() as SQLiteStorage;
      storage.close = () => {};

      // The breaker ends the run: waited for rather than raced against a timer, which a slow machine would lose
      const pipelinePromise = gekkoPipeline();
      try {
        await pipelinePromise;
        throw new Error('Pipeline should have thrown an error');
      } catch (err: any) {
        // The pipeline rejects with the ApplicationStopError itself (not a premature close), so main() can exit with 0
        expect(err).toBeInstanceOf(ApplicationStopError);
        expect(err.message).toBe('[STRATEGY] Max consecutive order errors reached (5)');
      }

      const calls = MockFetcherService.callHistory.filter(c => c.method === 'POST');

      // DebugAdvice logs "Order Errored: <id>" from onOrderErrored, which EventSubscriber posts as a strategy log, with the next bucket.
      // maxConsecutiveErrors defaults to 5: the strategy's onOrderErrored runs on the 5th error too, before the breaker throws, but its
      // line is still queued when the run stops, and is dropped with the failed bucket (PluginsStream). Hence exactly 4.
      const errorCalls = calls.filter(call => call.payload.text.includes('Order Errored'));
      expect(errorCalls.length).toBe(4);
    } finally {
      // The run ends before the exchange is restored: its orders still pending would otherwise be created after all
      await endRealtimeRun();
      DummyCentralizedExchange.prototype.createLimitOrder = createLimitOrder;
      DummyCentralizedExchange.prototype.processOneMinuteBucket = processOneMinuteBucket;
    }
  }, 30000);
});
