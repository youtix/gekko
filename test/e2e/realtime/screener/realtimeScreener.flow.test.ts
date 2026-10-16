import type { DebugAdviceParams } from '@strategies/debug/debugAdvice.types';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { FAST_MINUTE, minuteOf } from '../../helpers/clock.helper';
import { mockConfiguration, paperExchange } from '../../helpers/configuration.helper';
import { endRealtimeRun, mockRealtimeModules } from '../../helpers/realtimeRun.helper';
import { MockCCXTExchange } from '../../mocks/ccxt.mock';
import { MockFetcherService, SUBSCRIBE_ALL_UPDATES } from '../../mocks/fetcher.mock';
import { clearLogs, findTextLines, logStore } from '../../mocks/winston.mock';

// --------------------------------------------------------------------------
// MOCKS SETUP
// --------------------------------------------------------------------------

// DebugAdvice advises on every candle (each: 1), a SELL then a BUY, on every pair
const DEFAULT_MOCK_STRATEGY_CONFIG: { name: string } & Partial<DebugAdviceParams> = { name: 'DebugAdvice', each: 1 };

// Track candles emitted
const TARGET_CANDLES = 10;

// Wait for candles to be collected (with accelerated time, this should be fast)
// We'll wait for TARGET_CANDLES * FAST_MINUTE to give buffer
const TIMEOUT_MS = TARGET_CANDLES * FAST_MINUTE;

const TELEGRAM_TOKEN = 'test-token';
const TELEGRAM_USERNAME = 'test-bot';

// 1. Mock winston, the clock, ccxt and the fetcher, and end each test's run before the next test starts (see realtimeRun.helper)
mockRealtimeModules();
// The flows read the strategy's debug lines from the winston mock: the logger hands a debug line to winston only when
// GEKKO_LOG_LEVEL lets it through, and the logger is loaded after this, by the pipeline
process.env.GEKKO_LOG_LEVEL = 'debug';

// 2. Mock Configuration
let mockStrategyConfig = DEFAULT_MOCK_STRATEGY_CONFIG;
mockConfiguration(() => ({
  watch: {
    mode: 'realtime',
    assets: ['BTC', 'ETH'],
    currency: 'USDT',
    timeframe: '1m',
    tickrate: 100,
    warmup: { candleCount: 0, tickrate: 100 },
  },
  exchange: paperExchange([
    { assetName: 'BTC', balance: 100 },
    { assetName: 'ETH', balance: 100 },
    { assetName: 'USDT', balance: 300000 },
  ]),
  plugins: [
    { name: 'TradingAdvisor', strategyName: 'DebugAdvice' },
    { name: 'Trader' },
    { name: 'EventSubscriber', token: TELEGRAM_TOKEN, botUsername: TELEGRAM_USERNAME },
  ],
  strategy: mockStrategyConfig,
}));

describe('E2E: Realtime Screener Flow', () => {
  beforeEach(async () => {
    // Reset inject singletons
    const { inject } = await import('@services/injecter/injecter');
    inject.reset();
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
        return SUBSCRIBE_ALL_UPDATES;
      }
      return { ok: true, result: [] };
    });

    MockCCXTExchange.reset();

    // Reset config defaults
    mockStrategyConfig = DEFAULT_MOCK_STRATEGY_CONFIG;
  });

  // A realtime run never ends by itself: each test ends its own, plugins finalised and orders stopped, before the next one starts
  afterEach(() => endRealtimeRun());

  it('Scenario A: Standard Screener Flow (Buy/Sell Alert)', async () => {
    // Dynamic imports
    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');

    // Run pipeline
    const pipelinePromise = gekkoPipeline();
    await Promise.race([pipelinePromise, new Promise<void>(resolve => setTimeout(resolve, TIMEOUT_MS))]);

    // Verify Telegram messages were sent
    // We expect at least one message for order placement (DebugAdvice advises on every candle with each: 1, a SELL then a BUY)
    const texts = MockFetcherService.postedTexts();
    expect(texts.length).toBeGreaterThan(0);

    expect(texts.filter(text => text.includes('BUY')).length).toBeGreaterThanOrEqual(1);
    expect(texts.filter(text => text.includes('SELL')).length).toBeGreaterThanOrEqual(1);
  });

  it('Scenario B: Multi-Pair Signal Independence', async () => {
    // Both BTC and ETH are watched
    // Strategy triggers every candle (each: 1)

    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');

    const pipelinePromise = gekkoPipeline();
    await Promise.race([pipelinePromise, new Promise<void>(resolve => setTimeout(resolve, TIMEOUT_MS))]);

    const texts = MockFetcherService.postedTexts();
    // Check we have messages for BOTH pairs
    // We expect at least one message for each pair
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.filter(text => text.includes('BTC/USDT')).length).toBeGreaterThan(0);
    expect(texts.filter(text => text.includes('ETH/USDT')).length).toBeGreaterThan(0);
  });

  it('Scenario C: Strategy Creation order process', async () => {
    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');

    const pipelinePromise = gekkoPipeline();
    await Promise.race([pipelinePromise, new Promise<void>(resolve => setTimeout(resolve, TIMEOUT_MS))]);

    const texts = MockFetcherService.postedTexts();

    expect(texts.filter(text => text.includes('advice')).length).toBeGreaterThanOrEqual(2);
    expect(texts.filter(text => text.includes('order created')).length).toBeGreaterThanOrEqual(2);
    expect(texts.filter(text => text.includes('order completed')).length).toBeGreaterThanOrEqual(2);
  });

  it('Scenario D: Strategy Info Event Subscription (Logs)', async () => {
    // Strategy triggers logs every candle
    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');

    const pipelinePromise = gekkoPipeline();
    await Promise.race([pipelinePromise, new Promise<void>(resolve => setTimeout(resolve, TIMEOUT_MS))]);

    const texts = MockFetcherService.postedTexts();
    expect(texts.length).toBeGreaterThan(0);

    // Look for strategy info messages: the lines DebugAdvice logs at info, its signals and order outcomes
    // EventSubscriber formats it as: "• 2026-02-07T17:24:27.000Z [INFO] (strategy)\nTrigger SHORT for BTC/USDT\n------\n"
    const strategyInfoTexts = texts.filter(text => text.includes('[INFO] (strategy)'));
    expect(strategyInfoTexts.length).toBeGreaterThan(5);

    // Verify content of at least one message
    const sampleMessage = strategyInfoTexts.find(text => text.includes('Trigger'));
    expect(sampleMessage).toContain('BTC/USDT');

    // Its debug lines (Iteration, on every candle) are not relayed
    expect(texts.filter(text => text.includes('[DEBUG] (strategy)')).length).toBe(0);
  });

  it('Scenario E: Order Cancellation', async () => {
    // The orders rest until the strategy cancels them, a candle later: each pair's price falls after the candles DebugAdvice sells on
    // (the even ones) and rises after those it buys on, so that the candle after an order does not reach its LIMIT price. A STICKY
    // order is priced one price.min inside the ticker, the close of the last candle served, and the simulator fills a BUY on a low at
    // or below its price, a SELL on a high at or above it; an order priced once its pair has served the next candle still fills. The
    // cancellations came from the synthetic ticker running ahead of the candles: a flat market canceled nothing. The open-orders
    // switch the scenario set was read by nothing, the paper exchange sending every order to its simulator.
    const zigzag = Array.from({ length: 20 }, (_, index) => ({ close: index % 2 ? 90 : 100 }));
    MockCCXTExchange.setPredefinedCandles('BTC/USDT', zigzag);
    MockCCXTExchange.setPredefinedCandles('ETH/USDT', zigzag);

    // Configure strategy to cancel orders after 1 candle
    mockStrategyConfig = { ...DEFAULT_MOCK_STRATEGY_CONFIG, cancelAfter: 1 };

    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');

    const pipelinePromise = gekkoPipeline();
    await Promise.race([pipelinePromise, new Promise<void>(resolve => setTimeout(resolve, TIMEOUT_MS))]);

    const texts = MockFetcherService.postedTexts();
    expect(texts.length).toBeGreaterThan(0);

    // Check for Strategy Cancel Order notification
    expect(texts.filter(text => text.includes('Strategy requested order cancellation')).length).toBeGreaterThan(0);
    expect(texts.filter(text => text.includes('order canceled')).length).toBeGreaterThan(0);
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

      // DebugAdvice logs "Order Errored: <id>" from onOrderErrored, which EventSubscriber posts as a strategy log, with the next bucket.
      // maxConsecutiveErrors defaults to 5: the strategy's onOrderErrored runs on the 5th error too, before the breaker throws, but its
      // line is still queued when the run stops, and is dropped with the failed bucket (PluginsStream). Hence exactly 4.
      const errorTexts = MockFetcherService.postedTexts().filter(text => text.includes('Order Errored'));
      expect(errorTexts.length).toBe(4);
    } finally {
      // The run ends before the exchange is restored: its orders still pending would otherwise be created after all. Restored even
      // when the end fails the test, so that the next scenario does not run on the patched exchange.
      try {
        await endRealtimeRun();
      } finally {
        DummyCentralizedExchange.prototype.createLimitOrder = createLimitOrder;
        DummyCentralizedExchange.prototype.processOneMinuteBucket = processOneMinuteBucket;
      }
    }
  }, 30000);

  it('Scenario G: A pair without a candle in the first live minutes', async () => {
    // The exchange has no ETH candle for the first two minutes of the run, and with no warmup the gap filler has no earlier ETH candle
    // to fill those buckets with: they are dropped until ETH has one, instead of reaching the TradingAdvisor without ETH, which threw.
    // Two minutes, so that the gap holds the first live minute even when a minute starts while the run is being built.
    const firstMinute = minuteOf(Date.now());
    MockCCXTExchange.simulatedGaps = { 'ETH/USDT': [{ start: firstMinute, end: firstMinute + 2 * FAST_MINUTE }] };

    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');

    // Rejected, and so failing the test, if a bucket without ETH reached the TradingAdvisor
    const pipelinePromise = gekkoPipeline();
    await Promise.race([pipelinePromise, new Promise<void>(resolve => setTimeout(resolve, TIMEOUT_MS))]);

    // One warning per pair never seen at the first drop (the later drops are silent), then a summary at the first minute pushed
    const dropWarnings = findTextLines('dropping the leading buckets until every pair has a candle', 'warn');
    expect(dropWarnings.length).toBeGreaterThan(0);
    // The strategy started once both pairs had a candle
    expect(logStore.some(log => log.message === 'Iteration: 0 for ETH/USDT')).toBe(true);
  });
});
