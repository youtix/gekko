import type { SQLiteStorage } from '@services/storage/sqlite.storage';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { first } from 'lodash-es';
import { generateSyntheticCandle } from '../../fixtures/syntheticData';
import { FAST_MINUTE, minuteOf } from '../../helpers/clock.helper';
import { mockConfiguration } from '../../helpers/configuration.helper';
import { cleanDatabase, countCandles } from '../../helpers/database.helper';
import { endRealtimeRun, mockRealtimeModules } from '../../helpers/realtimeRun.helper';
import { MockCCXTExchange } from '../../mocks/ccxt.mock';
import { clearLogs, findTextLines } from '../../mocks/winston.mock';

// --------------------------------------------------------------------------
// MOCKS SETUP
// --------------------------------------------------------------------------

// Track candles emitted
const TARGET_CANDLES = 10;

// Wait for candles to be collected (with accelerated time, this should be fast)
// We'll wait for TARGET_CANDLES * FAST_MINUTE to give buffer
const TIMEOUT_MS = TARGET_CANDLES * FAST_MINUTE;

// 1. Mock winston, the clock, ccxt and the fetcher, and end each test's run before the next test starts (see realtimeRun.helper)
mockRealtimeModules();

// 2. Mock Configuration
// Configure all pairs from the start to ensure all tables are created
mockConfiguration({
  watch: {
    mode: 'realtime',
    assets: ['BTC', 'ETH', 'LTC'],
    currency: 'USDT',
    timeframe: '1m',
    tickrate: 100,
    warmup: { candleCount: 0, tickrate: 100 },
  },
  exchange: { name: 'binance' },
  storage: { type: 'sqlite', database: ':memory:' },
  plugins: [{ name: 'CandleWriter' }], // Enable writing to DB
});

describe('E2E: Realtime Writer (Synthetic)', () => {
  // Reset MockCCXTExchange static state and inject singletons before each test
  // This is especially important when running all E2E tests together
  beforeEach(async () => {
    // Reset inject singletons to get fresh storage/exchange for each test
    const { inject } = await import('@services/injecter/injecter');
    inject.reset();

    // Clean DB
    const storage = inject.storage() as SQLiteStorage;
    cleanDatabase(storage);
    clearLogs();

    MockCCXTExchange.reset();
  });

  // A realtime run never ends by itself: each test ends its own, plugins finalised and orders stopped, before the next one starts
  afterEach(() => endRealtimeRun());

  it('Scenario A: Realtime candle recording to SQLite', async () => {
    // Dynamic imports to ensure mocks are applied first
    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');

    // Get storage reference before pipeline runs
    const storage = inject.storage() as SQLiteStorage;
    // Keep DB open for subsequent tests
    storage.close = () => {};

    // Create a timeout promise to stop the pipeline after we collect enough candles
    const pipelinePromise = gekkoPipeline();

    // Use Promise.race with a timeout to stop waiting after enough time
    await Promise.race([pipelinePromise, new Promise<void>(resolve => setTimeout(resolve, TIMEOUT_MS))]);

    const db = storage.db;

    // Verify tables exist and have data
    // We should have at least some candles recorded
    // Due to the accelerated time, the exact count depends on timing
    expect(countCandles(storage, 'BTC/USDT')).toBeGreaterThanOrEqual(5);

    // Verify data integrity - check first candle
    const rows = db.query('SELECT * FROM candles_BTC_USDT ORDER BY start ASC').all() as any[];

    if (rows.length > 0) {
      const firstRow = first(rows);
      // Verify it has valid OHLCV data
      expect(firstRow.open).toBeDefined();
      expect(firstRow.high).toBeDefined();
      expect(firstRow.low).toBeDefined();
      expect(firstRow.close).toBeDefined();
      expect(firstRow.volume).toBeDefined();

      // Verify the synthetic data matches our generator
      const expectedCandle = generateSyntheticCandle('BTC/USDT', firstRow.start);
      expect(firstRow.open).toBeCloseTo(expectedCandle.open, 4);
    }
  }, 30000);

  it('Scenario B: Multi-pair recording consistency', async () => {
    // Storage is already configured with all pairs from the start

    // Dynamic imports to ensure mocks are applied first
    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');

    // Get storage reference - close is already disabled from Scenario A
    const storage = inject.storage() as SQLiteStorage;

    // Create a timeout promise to stop the pipeline after we collect enough candles
    const pipelinePromise = gekkoPipeline();

    // Use Promise.race with a timeout to stop waiting after enough time
    await Promise.race([pipelinePromise, new Promise<void>(resolve => setTimeout(resolve, TIMEOUT_MS))]);

    const db = storage.db;

    // Verify each pair has its own table with data
    // All pairs should have at least some candles recorded
    expect(countCandles(storage, 'BTC/USDT')).toBeGreaterThanOrEqual(1);
    expect(countCandles(storage, 'ETH/USDT')).toBeGreaterThanOrEqual(1);
    expect(countCandles(storage, 'LTC/USDT')).toBeGreaterThanOrEqual(1);

    // Verify no cross-contamination - each table should only have candles
    // matching the expected synthetic data for that pair
    const btcRows = db.query('SELECT * FROM candles_BTC_USDT ORDER BY start ASC').all() as any[];
    const ethRows = db.query('SELECT * FROM candles_ETH_USDT ORDER BY start ASC').all() as any[];
    const ltcRows = db.query('SELECT * FROM candles_LTC_USDT ORDER BY start ASC').all() as any[];

    // Verify BTC data integrity and uniqueness
    if (btcRows.length > 0) {
      const firstBtcRow = first(btcRows);
      const expectedBtcCandle = generateSyntheticCandle('BTC/USDT', firstBtcRow.start);
      expect(firstBtcRow.open).toBeCloseTo(expectedBtcCandle.open, 4);

      // Ensure this candle doesn't match ETH or LTC expected prices
      const wrongEthCandle = generateSyntheticCandle('ETH/USDT', firstBtcRow.start);
      const wrongLtcCandle = generateSyntheticCandle('LTC/USDT', firstBtcRow.start);

      // The prices should be different due to the symbol offset in synthetic generator
      expect(firstBtcRow.open).not.toBeCloseTo(wrongEthCandle.open, 4);
      expect(firstBtcRow.open).not.toBeCloseTo(wrongLtcCandle.open, 4);
    }

    // Verify ETH data integrity and uniqueness
    if (ethRows.length > 0) {
      const firstEthRow = first(ethRows);
      const expectedEthCandle = generateSyntheticCandle('ETH/USDT', firstEthRow.start);
      expect(firstEthRow.open).toBeCloseTo(expectedEthCandle.open, 4);

      // Ensure this candle doesn't match BTC or LTC expected prices
      const wrongBtcCandle = generateSyntheticCandle('BTC/USDT', firstEthRow.start);
      const wrongLtcCandle = generateSyntheticCandle('LTC/USDT', firstEthRow.start);

      expect(firstEthRow.open).not.toBeCloseTo(wrongBtcCandle.open, 4);
      expect(firstEthRow.open).not.toBeCloseTo(wrongLtcCandle.open, 4);
    }

    // Verify LTC data integrity and uniqueness
    if (ltcRows.length > 0) {
      const firstLtcRow = first(ltcRows);
      const expectedLtcCandle = generateSyntheticCandle('LTC/USDT', firstLtcRow.start);
      expect(firstLtcRow.open).toBeCloseTo(expectedLtcCandle.open, 4);

      // Ensure this candle doesn't match BTC or ETH expected prices
      const wrongBtcCandle = generateSyntheticCandle('BTC/USDT', firstLtcRow.start);
      const wrongEthCandle = generateSyntheticCandle('ETH/USDT', firstLtcRow.start);

      expect(firstLtcRow.open).not.toBeCloseTo(wrongBtcCandle.open, 4);
      expect(firstLtcRow.open).not.toBeCloseTo(wrongEthCandle.open, 4);
    }
  }, 30000);

  it('Scenario C: Handling of duplicate candle emissions', async () => {
    // A lie of the exchange, which ccxt would never let through: every third page has each of its candles stamped with the first
    // minute served, the prices of the minutes asked for kept
    MockCCXTExchange.emitDuplicatesEveryXCandle = 3;

    // Dynamic imports to ensure mocks are applied first
    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');

    // Get storage reference - close is already disabled from previous scenarios
    const storage = inject.storage() as SQLiteStorage;
    const db = storage.db;

    // Run the pipeline - this should NOT throw any errors even with duplicates
    const pipelinePromise = gekkoPipeline();

    // Use Promise.race with a timeout to stop waiting after enough time
    // The key assertion here is that this does NOT throw
    await Promise.race([pipelinePromise, new Promise<void>(resolve => setTimeout(resolve, TIMEOUT_MS))]);

    // ASSERTION 1: The pipeline completed without errors (we got here = no error thrown)

    // ASSERTION 2: Verify duplicate detection via logs
    // The live stream asks for the minutes after the last one it pushed: it drops a minute served again, with a warning
    const warningLogs = findTextLines('Ignored a duplicate 1m candle', 'warn');
    expect(warningLogs.length).toBeGreaterThan(0);

    // ASSERTION 3: Verify the stored candles are valid and not corrupted by duplicate handling
    const recentCandles = db.query('SELECT * FROM candles_BTC_USDT ORDER BY start DESC LIMIT 5').all() as any[];
    expect(recentCandles.length).toBeGreaterThan(0);

    // ASSERTION 4: The minute hidden behind a duplicate is asked for again on the next tick: every stored candle is the
    // exchange's own, none is a synthetic gap filler, the first one included, the minute the duplicates are stamped with. The five
    // newest rows never held it.
    const storedCandles = db.query('SELECT * FROM candles_BTC_USDT ORDER BY start ASC').all() as any[];
    const isExchangeCandle = (row: any) => row.open === generateSyntheticCandle('BTC/USDT', row.start).open;
    expect(storedCandles.every(isExchangeCandle)).toBe(true);
  }, 30000);

  it('Scenario D: Handling future candle emissions', async () => {
    // A lie of the exchange, which ccxt would never let through: every page opens with the candle of 5 minutes after the call
    MockCCXTExchange.emitFutureCandles = true;

    // Dynamic imports to ensure mocks are applied first
    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');

    // Get storage reference - close is already disabled from previous scenarios
    const storage = inject.storage() as SQLiteStorage;
    const db = storage.db;

    // Run the pipeline - this should NOT throw any errors even with future candles
    const pipelinePromise = gekkoPipeline();

    // Use Promise.race with a timeout to stop waiting after enough time
    // The key assertion here is that this does NOT throw
    await Promise.race([pipelinePromise, new Promise<void>(resolve => setTimeout(resolve, TIMEOUT_MS))]);

    // ASSERTION 1: The pipeline completed without errors (we got here = no error thrown)

    // ASSERTION 2: Verify no future candles are stored in the database
    // The system should gracefully ignore future candles. The mock's future candle starts 5 minutes after the fetch, off
    // the minute boundaries; the closed minutes recorded during the run legitimately start after the run started, so the
    // check is: nothing stored is unaligned, in progress or in the future at the end of the run.
    const currentFastMinute = minuteOf(Date.now());
    const selectNotClosed = (table: string) =>
      db.query(`SELECT * FROM ${table} WHERE start >= ? OR start % ? != 0`).all(currentFastMinute, FAST_MINUTE) as any[];

    // There should be NO future candles stored in the database
    expect(selectNotClosed('candles_BTC_USDT').length).toBe(0);

    // ASSERTION 3: Also check ETH and LTC tables for no future candles
    expect(selectNotClosed('candles_ETH_USDT').length).toBe(0);
    expect(selectNotClosed('candles_LTC_USDT').length).toBe(0);

    // ASSERTION 4: The future candle does not hide the closed minute served with it
    expect(countCandles(storage, 'BTC/USDT')).toBeGreaterThan(0);
  }, 30000);

  it('Scenario E: Filling candle gaps', async () => {
    // Set the daterange to include gaps
    MockCCXTExchange.simulatedGaps = [{ start: Date.now() + 2 * FAST_MINUTE, end: Date.now() + 5 * FAST_MINUTE }];

    // Dynamic imports to ensure mocks are applied first
    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');

    // Get storage reference - close is already disabled from previous scenarios
    const storage = inject.storage() as SQLiteStorage;
    const db = storage.db;

    // Run the pipeline - this should NOT throw any errors even with gaps
    const pipelinePromise = gekkoPipeline();

    // Use Promise.race with a timeout to stop waiting after enough time
    // CRITICAL: The pipeline should complete without throwing any errors
    await Promise.race([pipelinePromise, new Promise<void>(resolve => setTimeout(resolve, TIMEOUT_MS))]);

    // ASSERTION 1: The pipeline completed without errors (reaching here = success)
    // If the gap filling failed or threw an error, we wouldn't get here

    // ASSERTION 2: Verify no gaps exist in the stored candles
    // The FillCandleGapStream should have filled any missing candles from the exchange
    const btcCandles = db.query('SELECT start FROM candles_BTC_USDT ORDER BY start ASC').all() as { start: number }[];

    // We should have at least 1 candle stored
    expect(btcCandles.length).toBeGreaterThanOrEqual(1);

    // If we have multiple candles, verify no gaps exist between them
    if (btcCandles.length >= 2) {
      for (let i = 1; i < btcCandles.length; i++) {
        const gap = btcCandles[i].start - btcCandles[i - 1].start;
        // Each candle should be exactly one minute after the previous one (no gaps)
        // The FillCandleGapStream fills missing candles with empty/synthetic candles
        expect(gap).toBe(FAST_MINUTE);
      }
    }

    // ASSERTION 3: Verify the same for ETH and LTC tables
    const ethCandles = db.query('SELECT start FROM candles_ETH_USDT ORDER BY start ASC').all() as { start: number }[];
    for (let i = 1; i < ethCandles.length; i++) {
      const gap = ethCandles[i].start - ethCandles[i - 1].start;
      expect(gap).toBe(FAST_MINUTE);
    }

    const ltcCandles = db.query('SELECT start FROM candles_LTC_USDT ORDER BY start ASC').all() as { start: number }[];
    for (let i = 1; i < ltcCandles.length; i++) {
      const gap = ltcCandles[i].start - ltcCandles[i - 1].start;
      expect(gap).toBe(FAST_MINUTE);
    }

    // ASSERTION 4: Verify filled candles have valid OHLCV data
    // Even gap-filled candles should have proper positive values
    const allCandles = db.query('SELECT * FROM candles_BTC_USDT ORDER BY start DESC LIMIT 10').all() as any[];
    for (const candle of allCandles) {
      expect(candle.open).toBeDefined();
      expect(candle.open).toBeGreaterThan(0);
      expect(candle.high).toBeDefined();
      expect(candle.high).toBeGreaterThan(0);
      expect(candle.low).toBeDefined();
      expect(candle.low).toBeGreaterThan(0);
      expect(candle.close).toBeDefined();
      expect(candle.close).toBeGreaterThan(0);
      expect(candle.volume).toBeDefined();
      // Volume can be 0 for gap-filled candles, so we don't check > 0
    }
  }, 30000);

  it('Scenario F: Custom batch size buffering', async () => {
    // This test validates that the writer respects the insertThreshold configuration,
    // buffering candles in memory and only flushing to disk when the threshold is reached
    // or on finalize.

    // Dynamic imports to ensure mocks are applied first
    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');

    // Get storage reference - close is already disabled from previous scenarios
    const storage = inject.storage() as SQLiteStorage;
    const db = storage.db;

    // Access the buffer and insertThreshold via the storage instance
    // Note: The buffer is protected, so we access it directly for testing
    const getBufferLength = () => storage['buffer'].length;
    const getInsertThreshold = () => storage['insertThreshold'];

    // ASSERTION 1: Verify the insertThreshold is correctly set for realtime mode
    // In realtime mode, default is 1 (unless overridden in config)
    const insertThreshold = getInsertThreshold();
    expect(insertThreshold).toBe(1); // Realtime mode default

    // Run the pipeline
    const pipelinePromise = gekkoPipeline();

    // Use Promise.race with a timeout to stop waiting after enough time
    await Promise.race([pipelinePromise, new Promise<void>(resolve => setTimeout(resolve, TIMEOUT_MS))]);

    // ASSERTION 2: The pipeline completed without errors (we got here = no error thrown)

    // ASSERTION 3: With insertThreshold = 1, the buffer should always be empty or 0
    // because each candle is flushed immediately after being added
    const bufferLength = getBufferLength();
    expect(bufferLength).toBeLessThanOrEqual(insertThreshold);

    // ASSERTION 4: Verify data integrity - all stored candles should have valid OHLCV data
    const allCandles = db.query('SELECT * FROM candles_BTC_USDT ORDER BY start DESC LIMIT 10').all() as any[];

    // We should have candles stored
    expect(allCandles.length).toBeGreaterThan(0);

    for (const candle of allCandles) {
      // Each candle should have valid OHLCV data
      expect(candle.open).toBeDefined();
      expect(candle.high).toBeDefined();
      expect(candle.low).toBeDefined();
      expect(candle.close).toBeDefined();
      expect(candle.volume).toBeDefined();

      // Verify data matches the synthetic generator
      const expectedCandle = generateSyntheticCandle('BTC/USDT', candle.start);
      expect(candle.open).toBeCloseTo(expectedCandle.open, 4);
    }

    // ASSERTION 5: Verify candles are contiguous (no gaps caused by buffering issues)
    const orderedCandles = db.query('SELECT start FROM candles_BTC_USDT ORDER BY start ASC').all() as { start: number }[];

    if (orderedCandles.length >= 2) {
      for (let i = 1; i < orderedCandles.length; i++) {
        const gap = orderedCandles[i].start - orderedCandles[i - 1].start;
        // Each candle should be exactly one minute after the previous one
        expect(gap).toBe(FAST_MINUTE);
      }
    }
  }, 30000);
});
