import { ONE_MINUTE } from '@constants/time.const';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { startFakeClock } from '../../helpers/clock.helper';
import { mockConfiguration, paperExchange, type RawConfiguration } from '../../helpers/configuration.helper';
import { endRealtimeRun, mockRealtimeModules, runRealtimeUntil } from '../../helpers/realtimeRun.helper';
import { MockCCXTExchange } from '../../mocks/ccxt.mock';
import { clearLogs, findLoggedObject, findTextLine, findTextLines, isTextLine, logStore } from '../../mocks/winston.mock';

// --------------------------------------------------------------------------
// MOCKS SETUP
// --------------------------------------------------------------------------

// 1. Mock winston, ccxt and the fetcher. Each test runs on real minutes under the fake clock, and ends its run before the next test
// starts (see realtimeRun.helper)
mockRealtimeModules();
// The flows read the strategy's debug lines from the winston mock: the logger hands a debug line to winston only when
// GEKKO_LOG_LEVEL lets it through, and the logger is loaded after this, by the pipeline
process.env.GEKKO_LOG_LEVEL = 'debug';

// 2. Mock Configuration
let mockStrategyConfig: NonNullable<RawConfiguration['strategy']>;
mockConfiguration(() => ({
  watch: { mode: 'realtime', assets: ['BTC'], currency: 'USDT', timeframe: '1m', tickrate: 100, warmup: { candleCount: 0 } },
  exchange: paperExchange([
    { assetName: 'BTC', balance: 100 },
    { assetName: 'USDT', balance: 300000 },
  ]),
  plugins: [{ name: 'TradingAdvisor', strategyName: mockStrategyConfig.name }, { name: 'Trader' }, { name: 'RoundTripAnalyzer' }],
  strategy: mockStrategyConfig,
}));

// --------------------------------------------------------------------------
// TEST SUITE
// --------------------------------------------------------------------------

describe('E2E: Realtime Paper Trader Flow', () => {
  beforeEach(async () => {
    // Reset inject singletons
    const { inject } = await import('@services/injecter/injecter');
    inject.reset();
    clearLogs();

    // Reset mocks
    MockCCXTExchange.reset();
    startFakeClock();
  });

  // A realtime run never ends by itself: each test ends its own, plugins finalised and orders stopped, before the next one starts
  afterEach(() => endRealtimeRun());

  it('Scenario A: Intermediary Roundtrip Completion', async () => {
    // Use the debug strategy specifically designed for this scenario (Buy on 0, Sell on 1)
    mockStrategyConfig = { name: 'DebugRealtime' };

    // Setup predefined candles to trigger buying and selling at predictable prices
    MockCCXTExchange.setPredefinedCandles('BTC/USDT', [
      { close: 100 }, // Iteration 0 -> Buys 1 BTC at 100
      { close: 110 }, // Iteration 1 -> Sells 1 BTC at 110
      { close: 120 }, // Extra candle to ensure processing ends safely
      { close: 125 }, // One more buffer candle
    ]);

    // One candle a minute: the round trip exits on the second, and is reported with the third
    const isRoundtrip = (message: Record<string, any>) => 'entryAt' in message && 'exitAt' in message && 'profit' in message;
    await runRealtimeUntil(() => findLoggedObject(isRoundtrip) !== undefined, { maxMinutes: 5 });

    // Assert logs verify the execution of the e2e test
    expect(findTextLine('Trigger BUY for BTC/USDT')).toBeDefined();
    expect(findTextLine('Trigger SELL for BTC/USDT')).toBeDefined();

    // Assert roundtrip state from Final Trading Report logged by RoundTripAnalyzer
    // In realtime, processFinalize isn't called, so we check the individual roundtrip log
    const roundtrip = findLoggedObject(isRoundtrip)!;
    expect(roundtrip).toBeDefined();

    // There should be exactly one completed roundtrip
    // Test every property from the intermediary roundtrip report for strong e2e validation
    expect(roundtrip.id).toBe(0);
    expect(roundtrip.entryAt).toBeTypeOf('number');
    expect(roundtrip.entryPrice).toBe(100);
    // The simulator charges the taker fee of the market, Binance's 0.1 %, on top of a MARKET BUY and out of a SELL's proceeds. The BUY
    // of 1 BTC at 100 costs 100.1: 101 BTC and 299,899.9 USDT, $309,999.9 at $100/BTC. The entry equity gives the BUY's fee back:
    // 309,999.9 + 0.1 = $310,000, the 100 BTC * $100 + 300,000 USDT held before it
    expect(roundtrip.entryEquity).toBe(310000);

    expect(roundtrip.exitAt).toBeTypeOf('number');
    expect(roundtrip.exitAt).toBeGreaterThan(roundtrip.entryAt);
    expect(roundtrip.exitPrice).toBe(110);
    // The SELL of 1 BTC at 110 brings 110 - 0.11 = 109.89: 100 BTC and 300,009.79 USDT. At $110/BTC: 100 * 110 + 300,009.79 = $311,009.79
    expect(roundtrip.exitEquity).toBe(311009.79);

    expect(roundtrip.pnl).toBe(1009.79); // 311,009.79 - 310,000
    expect(roundtrip.profit).toBe(0.325738709677419); // 1,009.79 / 310,000 * 100, to 15 significant digits
    expect(roundtrip.maxAdverseExcursion).toBe(0);
    // Exited a minute after the entry, the SELL on the candle after the BUY's
    expect(roundtrip.duration).toBe(ONE_MINUTE);
  });
  it('Scenario B: Trailing Stop Lifecycle', async () => {
    // Override strategy to use DebugTrailingStop with trailing stop config
    mockStrategyConfig = { name: 'DebugTrailingStop', wait: 0, trigger: 9930, percentage: 0.1 };

    MockCCXTExchange.setPredefinedCandles('BTC/USDT', [
      { close: 9500 }, // Places BUY order
      { close: 9500 }, // TS dormant
      { close: 10000, high: 10000, low: 9995 }, // TS active, stopPrice == 9990
      { close: 9800, high: 9995, low: 9800 }, // TS triggers SELL
      { close: 9800 }, // SELL completes
      { close: 9800 },
    ]);

    // Until the stop's SELL, placed on the fourth candle, is reported completed with the fifth
    await runRealtimeUntil(() => findTextLines('Trailing stop order completed').length >= 2, { maxMinutes: 8 });

    // Verify trailing stop BUY order was created by the strategy
    expect(findTextLine('Trailing stop BUY order created')).toBeDefined();

    // Verify the orders were completed (BUY order completed and then SELL order completed after trigger)
    const completedLogs = findTextLines('Trailing stop order completed');
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

  it('Scenario C: The end of the run, by the abort of its signal, reported as its interruption', async () => {
    mockStrategyConfig = { name: 'DebugRealtime' };
    MockCCXTExchange.setPredefinedCandles('BTC/USDT', [{ close: 100 }, { close: 110 }, { close: 120 }]);
    await runRealtimeUntil(() => findTextLine('Trigger SELL for BTC/USDT') !== undefined, { maxMinutes: 5 });

    // The plugins are finalised with the AbortError as the failure that stopped the run, which the final report names. The harness
    // destroyed the last stream without an error instead, so that the plugins were finalised as at the end of a completed run, an end no
    // realtime run has in production.
    await endRealtimeRun();
    expect(findLoggedObject(message => message.id === 'TRADING REPORT')?.interruption).toBe('The operation was aborted.');
  });
});
