import type { SQLiteStorage } from '@services/storage/sqlite.storage';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanDatabase } from '../../helpers/database.helper';
import { endRealtimeRun, trackRealtimeRuns } from '../../helpers/realtimeRun.helper';
import { createCcxtModuleMock, MockCCXTExchange } from '../../mocks/ccxt.mock';
import { MockFetcherService } from '../../mocks/fetcher.mock';
import { MockHeart } from '../../mocks/heart.mock';
import { MockWinston, clearLogs, isTextLine, logStore } from '../../mocks/winston.mock';

// --------------------------------------------------------------------------
// MOCKS SETUP
// --------------------------------------------------------------------------
const DEFAULT_MOCK_STRATEGY_CONFIG = { name: 'DebugAdvice', each: 2 };
const DEFAULT_MOCK_STRATEGY_NAME = 'DebugAdvice';

const FAST_MINUTE = 50;
const TARGET_CANDLES = 10; // Track candles emitted

// Wait for candles to be collected (with accelerated time, this should be fast)
// We'll wait for TARGET_CANDLES * FAST_MINUTE to give buffer
const TIMEOUT_MS = TARGET_CANDLES * FAST_MINUTE;

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
let mockPairs = [{ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' }];
let mockStrategyConfig: any = DEFAULT_MOCK_STRATEGY_CONFIG;
let mockStrategyName = DEFAULT_MOCK_STRATEGY_NAME;
mock.module('@services/configuration/configuration', () => {
  return {
    config: {
      getWatch: () => ({
        mode: 'realtime',
        pairs: mockPairs,
        timeframe: '1m',
        tickrate: 100,
        warmup: { candleCount: 0 },
        assets: ['BTC'],
        currency: 'USDT',
      }),
      showLogo: () => false,
      getExchange: () => ({
        name: 'paper-binance',
        verbose: false,
        simulationBalance: new Map([
          ['BTC', 100],
          ['USDT', 300000],
        ]),
        exchangeSynchInterval: 10 * 60 * 1000,
      }),
      getStorage: () => ({
        type: 'sqlite',
        database: ':memory:', // Isolated DB
      }),
      getPlugins: () => [{ name: 'TradingAdvisor', strategyName: mockStrategyName }, { name: 'Trader' }, { name: 'RoundTripAnalyzer' }],
      getStrategy: () => mockStrategyConfig,
    },
  };
});

// 5. Mock CCXT Library

mock.module('ccxt', () => createCcxtModuleMock());

// 6. Mock Heart
mock.module('@services/core/heart/heart', () => ({
  Heart: MockHeart,
}));

// 7. End each test's run before the next test starts (see realtimeRun.helper)
trackRealtimeRuns();

// --------------------------------------------------------------------------
// TEST SUITE
// --------------------------------------------------------------------------

describe('E2E: Realtime Paper Trader Flow', () => {
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
    MockCCXTExchange.resetPredefinedCandles();

    // Configure Telegram subscription response (only once)
    let getCallCount = 0;
    MockFetcherService.when('getUpdates').thenReturn(() => {
      if (++getCallCount === 1) return subscriptionResponse;
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
    mockStrategyName = DEFAULT_MOCK_STRATEGY_NAME;
    mockPairs = [{ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' }];
  });

  // A realtime run never ends by itself: each test ends its own, plugins finalised and orders stopped, before the next one starts
  afterEach(() => endRealtimeRun());

  it('Scenario A: Intermediary Roundtrip Completion', async () => {
    // Use the debug strategy specifically designed for this scenario (Buy on 0, Sell on 1)
    mockStrategyName = 'DebugRealtime';
    mockStrategyConfig = { name: 'DebugRealtime' };

    // Setup predefined candles to trigger buying and selling at predictable prices
    MockCCXTExchange.setPredefinedCandles('BTC/USDT', [
      { close: 100 }, // Iteration 0 -> Buys 1 BTC at 100
      { close: 110 }, // Iteration 1 -> Sells 1 BTC at 110
      { close: 120 }, // Extra candle to ensure processing ends safely
      { close: 125 }, // One more buffer candle
    ]);

    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');
    const { expect } = await import('bun:test');

    // Get storage reference
    const storage = inject.storage() as SQLiteStorage;
    storage.close = () => {};

    // Start pipeline and wait for timeout
    const pipelinePromise = gekkoPipeline();
    await Promise.race([pipelinePromise, new Promise<void>(resolve => setTimeout(resolve, TIMEOUT_MS))]);

    // Assert logs verify the execution of the e2e test
    const logs = logStore.map(l => l.message);
    const hasBuyLog = logs.some(l => typeof l === 'string' && l.includes('Trigger BUY for BTC/USDT'));
    const hasSellLog = logs.some(l => typeof l === 'string' && l.includes('Trigger SELL for BTC/USDT'));

    expect(hasBuyLog).toBe(true);
    expect(hasSellLog).toBe(true);

    // Assert roundtrip state from Final Trading Report logged by RoundTripAnalyzer
    // In realtime, processFinalize isn't called, so we check the individual roundtrip log
    const isObject = (value: unknown) => typeof value === 'object' && value !== null;
    const isRoundtrip = (value: unknown) => isObject(value) && 'entryAt' in value && 'exitAt' in value && 'profit' in value;
    const roundtripPayload = logStore.find(log => isRoundtrip(log.message));
    expect(roundtripPayload).toBeDefined();

    const roundtrip = roundtripPayload!.message as any;

    // There should be exactly one completed roundtrip
    // Test every property from the intermediary roundtrip report for strong e2e validation
    expect(roundtrip.id).toBe(0);
    expect(roundtrip.entryAt).toBeTypeOf('number');
    expect(roundtrip.entryPrice).toBe(100);
    // 100 BTC * $100 + 300,000 USDT = $310,000
    expect(roundtrip.entryEquity).toBe(310000);

    expect(roundtrip.exitAt).toBeTypeOf('number');
    expect(roundtrip.exitAt).toBeGreaterThan(roundtrip.entryAt);
    expect(roundtrip.exitPrice).toBe(110);
    // After buy: 101 BTC, 299,900 USDT. At $110/BTC: 101 * 110 + 299,900 = $311,010
    // After sell: 100 BTC, 300,010 USDT. At $110/BTC: 100 * 110 + 300,010 = $311,010
    expect(roundtrip.exitEquity).toBe(311010);

    expect(roundtrip.pnl).toBe(1010); // 311010 - 310000
    expect(roundtrip.profit).toBeCloseTo(0.3258, 4); // (311010 / 310000 - 1) * 100
    expect(roundtrip.maxAdverseExcursion).toBe(0);
    expect(roundtrip.duration).toBe(FAST_MINUTE);
  });
  it('Scenario B: Trailing Stop Lifecycle', async () => {
    // Override strategy to use DebugTrailingStop with trailing stop config
    mockStrategyName = 'DebugTrailingStop';
    mockStrategyConfig = { name: 'DebugTrailingStop', wait: 0, trigger: 9930, percentage: 0.1 };

    MockCCXTExchange.setPredefinedCandles('BTC/USDT', [
      { close: 9500 }, // Places BUY order
      { close: 9500 }, // TS dormant
      { close: 10000, high: 10000, low: 9995 }, // TS active, stopPrice == 9990
      { close: 9800, high: 9995, low: 9800 }, // TS triggers SELL
      { close: 9800 }, // SELL completes
      { close: 9800 },
    ]);

    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');
    const storage = inject.storage() as SQLiteStorage;
    storage.close = () => {};

    const pipelinePromise = gekkoPipeline();
    await Promise.race([pipelinePromise, new Promise<void>(resolve => setTimeout(resolve, TIMEOUT_MS))]);

    // Verify trailing stop BUY order was created by the strategy
    const createdLog = logStore.find(log => typeof log.message === 'string' && log.message.includes('Trailing stop BUY order created'));
    expect(createdLog).toBeDefined();

    // Verify the orders were completed (BUY order completed and then SELL order completed after trigger)
    const completedLogs = logStore.filter(log => typeof log.message === 'string' && log.message.includes('Trailing stop order completed'));
    expect(completedLogs.length).toBeGreaterThanOrEqual(2);

    // The StrategyManager forwarded both hooks of the stop to the strategy, which logs them: the orders completed are the BUY, then the
    // SELL the trigger hook was given
    const lineStartingWith = (prefix: string) => logStore.filter(isTextLine).find(({ message }) => message.startsWith(prefix));
    expect(lineStartingWith('Trailing stop activated')).toBeDefined();
    const [, buyId, sellId] = lineStartingWith('Trailing stop triggered')?.message.match(/BUY (\S+) .* MARKET SELL (\S+)/) ?? [];
    expect(completedLogs.map(log => log.message)).toEqual([
      `Trailing stop order completed: ${buyId}`,
      `Trailing stop order completed: ${sellId}`,
    ]);
  });
});
