import { ONE_MINUTE } from '@constants/time.const';
import type { SQLiteStorage } from '@services/storage/sqlite.storage';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { first, last } from 'lodash-es';
import { generateSyntheticCandle } from '../fixtures/syntheticData';
import { createCcxtModuleMock, MockCCXTExchange } from '../mocks/ccxt.mock';
import { MockWinston, clearLogs, isTextLine, logStore } from '../mocks/winston.mock';

// --------------------------------------------------------------------------
// MOCKS SETUP
// --------------------------------------------------------------------------

// 0. Mock Winston
mock.module('winston', () => MockWinston);

// 1. Mock Configuration
const START_TIME = 1700000000000 - (1700000000000 % ONE_MINUTE); // Minute-aligned start time
const END_TIME = START_TIME + 60 * ONE_MINUTE; // 1 hour of data

// Dynamic config state
let mockDaterange = {
  start: START_TIME,
  end: END_TIME,
};

let mockPairs = [
  { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' },
  { symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT' },
];

// Start time for Scenario B (Single Asset)
const SCENARIO_B_START = END_TIME + 60 * ONE_MINUTE; // 1 hour later
const SCENARIO_B_END = SCENARIO_B_START + 60 * ONE_MINUTE;

// Start time for Scenario C (Scale - 1000 candles)
const SCENARIO_C_START = SCENARIO_B_END + 60 * ONE_MINUTE;
const SCENARIO_C_END = SCENARIO_C_START + 1000 * ONE_MINUTE;

// Start time for Scenario D (Error Handling)
const SCENARIO_D_START = SCENARIO_C_END + 60 * ONE_MINUTE;
const SCENARIO_D_END = SCENARIO_D_START + 60 * ONE_MINUTE;

// Start time for Scenario E (Idempotency)
const SCENARIO_E_START = SCENARIO_D_END + 60 * ONE_MINUTE;
const SCENARIO_E_END = SCENARIO_E_START + 60 * ONE_MINUTE;

// Start time for Scenario F (Partial Overlap)
const SCENARIO_F_START = SCENARIO_E_END + 60 * ONE_MINUTE;

// Start time for Scenario G (Partial Gap)
const SCENARIO_G_START = SCENARIO_F_START + 60 * ONE_MINUTE;
const SCENARIO_G_END = SCENARIO_G_START + 60 * ONE_MINUTE;

// Start time for Scenario H (Total Gap)
const SCENARIO_H_START = SCENARIO_G_END + 60 * ONE_MINUTE;
const SCENARIO_H_END = SCENARIO_H_START + 60 * ONE_MINUTE;

// Start time for Scenario I (Leading Gap - gap at the start)
const SCENARIO_I_START = SCENARIO_H_END + 60 * ONE_MINUTE;
const SCENARIO_I_END = SCENARIO_I_START + 60 * ONE_MINUTE;

// Start time for Scenario J (Trailing Gap - gap at the end)
const SCENARIO_J_START = SCENARIO_I_END + 60 * ONE_MINUTE;
const SCENARIO_J_END = SCENARIO_J_START + 60 * ONE_MINUTE;

mock.module('@services/configuration/configuration', () => {
  return {
    config: {
      getWatch: () => ({
        mode: 'importer',
        pairs: mockPairs,
        daterange: mockDaterange,
        tickrate: 100,
        warmup: { candleCount: 0 },
      }),
      showLogo: () => false,
      getExchange: () => ({
        name: 'binance', // Matches key in mocking below
        verbose: false,
      }),
      getStorage: () => ({
        type: 'sqlite',
        database: ':memory:', // Isolated DB
      }),
      getPlugins: () => [
        {
          name: 'CandleWriter', // Enable writing to DB
        },
      ],
      getStrategy: () => ({}),
    },
  };
});

// 2. Mock CCXT Library
mock.module('ccxt', () => createCcxtModuleMock());

import { cleanDatabase } from '../helpers/database.helper';

// --------------------------------------------------------------------------
// TEST SUITE
// --------------------------------------------------------------------------

describe('E2E: Importer (Synthetic)', () => {
  beforeEach(async () => {
    // Reset inject singletons to get fresh storage/exchange for each test
    const { inject } = await import('@services/injecter/injecter');
    inject.reset();

    // Clean DB
    const storage = inject.storage() as SQLiteStorage;
    cleanDatabase(storage);
    clearLogs();
    storage.close = () => storage['flush'](); // Insert the buffered candles but keep the in-memory database open for the assertions

    // Reset MockCCXTExchange static state
    MockCCXTExchange.simulatedGaps = [];
    MockCCXTExchange.shouldThrowError = false;
    MockCCXTExchange.emitDuplicatesEveryXCandle = 0;
    MockCCXTExchange.emitFutureCandles = false;
    MockCCXTExchange.mockTrades = [];
    MockCCXTExchange.shouldThrowOnCreateOrder = false;
    MockCCXTExchange.simulateOpenOrders = false;
  });

  it('Scenario A: Multi-Asset Ingestion & Persistence', async () => {
    // Reset config for Scenario A (default)
    mockPairs = [
      { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' },
      { symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT' },
    ];
    mockDaterange = { start: START_TIME, end: END_TIME };

    // Dynamic imports to ensure mocks are applied first
    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');

    // 1. Run the Pipeline
    // Monkey-patch storage.close to prevent closure before verification
    const storage = inject.storage() as SQLiteStorage;
    storage.close = () => storage['flush']();

    await gekkoPipeline();

    // 2. Verify Storage Persistence
    const db = storage['db']; // Access private db instance

    // Verify tables exist and have data
    // Casting to any to access private db for verification
    const rowCountBTC = db
      .query('SELECT count(*) as count FROM candles_BTC_USDT WHERE start >= ? AND start <= ?')
      .get(START_TIME, END_TIME) as { count: number };
    const rowCountETH = db
      .query('SELECT count(*) as count FROM candles_ETH_USDT WHERE start >= ? AND start <= ?')
      .get(START_TIME, END_TIME) as { count: number };

    expect(rowCountBTC.count).toBe(61); // 60 minutes + 1 inclusive
    expect(rowCountETH.count).toBe(61);

    // 3. Verify Data Integrity (Multi-asset sync)
    // Check first and last candle of BTC in this range
    const rows = db
      .query('SELECT * FROM candles_BTC_USDT WHERE start >= ? AND start <= ? ORDER BY start ASC')
      .all(START_TIME, END_TIME) as any[];
    const firstRow = first(rows);
    const lastRow = last(rows);

    expect(firstRow.start).toBe(START_TIME);
    expect(lastRow.start).toBe(END_TIME); // inclusive end

    // Verify values match synthetic generator
    const expectedFirst = generateSyntheticCandle('BTC/USDT', START_TIME);
    expect(firstRow.open).toBeCloseTo(expectedFirst.open, 8);
    expect(firstRow.close).toBeCloseTo(expectedFirst.close, 8);
  }, 60000);

  it('Scenario B: Single-Asset Ingestion', async () => {
    // Update Config for Scenario B
    mockDaterange = { start: SCENARIO_B_START, end: SCENARIO_B_END };
    mockPairs = [{ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' }]; // Only BTC

    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');
    const storage = inject.storage() as SQLiteStorage;
    const db = storage['db'];

    // Run Pipeline
    await gekkoPipeline();

    // Verify BTC Data
    const rowCountBTC = db
      .query('SELECT count(*) as count FROM candles_BTC_USDT WHERE start >= ? AND start <= ?')
      .get(SCENARIO_B_START, SCENARIO_B_END) as { count: number };
    expect(rowCountBTC.count).toBe(61);

    // Verify ETH Data (Should NOT be present for this range)
    // Note: ETH table exists from Scenario A/B, but should contain no rows for this specific daterange
    const rowCountETH = db
      .query('SELECT count(*) as count FROM candles_ETH_USDT WHERE start >= ? AND start <= ?')
      .get(SCENARIO_B_START, SCENARIO_B_END) as { count: number };
    expect(rowCountETH.count).toBe(0);

    // Verify Start/End for BTC
    const rows = db
      .query('SELECT * FROM candles_BTC_USDT WHERE start >= ? AND start <= ? ORDER BY start ASC')
      .all(SCENARIO_B_START, SCENARIO_B_END) as any[];
    const firstRow = first(rows);
    const lastRow = last(rows);

    expect(firstRow.start).toBe(SCENARIO_B_START);
    expect(lastRow.start).toBe(SCENARIO_B_END);
  }, 60000);

  it('Scenario C: Scale & Resource Lifecycle (1000 candles)', async () => {
    mockDaterange = { start: SCENARIO_C_START, end: SCENARIO_C_END };
    mockPairs = [{ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' }];

    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');
    const storage = inject.storage() as SQLiteStorage;
    const db = storage['db'];

    await gekkoPipeline();

    const rowCountBTC = db
      .query('SELECT count(*) as count FROM candles_BTC_USDT WHERE start >= ? AND start <= ?')
      .get(SCENARIO_C_START, SCENARIO_C_END) as { count: number };

    expect(rowCountBTC.count).toBe(1001); // 1000 minutes + 1 inclusive

    // The range spans two exchange pages: the second one, requested from the millisecond after the last candle of the
    // first, must start at the next minute, and the last minute of the range must be there
    const { lastStart, offGridRows } = db
      .query(
        'SELECT max(start) as lastStart, count(CASE WHEN start % ? != 0 THEN 1 END) as offGridRows FROM candles_BTC_USDT WHERE start >= ? AND start <= ?',
      )
      .get(ONE_MINUTE, SCENARIO_C_START, SCENARIO_C_END) as { lastStart: number; offGridRows: number };
    expect(lastStart).toBe(SCENARIO_C_END);
    expect(offGridRows).toBe(0);
  }, 120000); // Higher timeout for larger scale

  it('Scenario D: Error Handling & Resilience (Simulated Network Error)', async () => {
    mockDaterange = { start: SCENARIO_D_START, end: SCENARIO_D_END };
    mockPairs = [{ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' }];

    // Enable error
    MockCCXTExchange.shouldThrowError = true;

    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');

    // The exchange's failure fails the import with its own error. The scenario accepted a normal end without a row as well as any
    // error, so it passed when the candle streams' relay took the failure for the end of the pair's stream (an import that completes
    // without its candles) or lost it behind another error. Caught rather than asserted through `rejects`, which Bun waits on past the
    // test's timeout: an import that froze would hang the suite instead of failing here.
    try {
      const failure = await gekkoPipeline().then(
        () => new Error('The import completed'),
        (error: unknown) => error,
      );
      expect(failure).toHaveProperty('message', 'Simulated Network Error');
    } finally {
      MockCCXTExchange.shouldThrowError = false;
    }
  }, 60000);

  it('Scenario E: Idempotency (Double Import)', async () => {
    mockDaterange = { start: SCENARIO_E_START, end: SCENARIO_E_END };
    mockPairs = [{ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' }];

    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');
    const storage = inject.storage() as SQLiteStorage;
    const db = storage['db'];

    // First Run
    await gekkoPipeline();

    const rowCount1 = db
      .query('SELECT count(*) as count FROM candles_BTC_USDT WHERE start >= ? AND start <= ?')
      .get(SCENARIO_E_START, SCENARIO_E_END) as { count: number };

    expect(rowCount1.count).toBe(61);

    // Second Run (Same range)
    await gekkoPipeline();

    const rowCount2 = db
      .query('SELECT count(*) as count FROM candles_BTC_USDT WHERE start >= ? AND start <= ?')
      .get(SCENARIO_E_START, SCENARIO_E_END) as { count: number };

    // Should be SAME count (no duplicates)
    expect(rowCount2.count).toBe(61);
  }, 60000);

  it('Scenario F: Partial Overlap', async () => {
    // Range F1: T to T+30
    const G1_START = SCENARIO_F_START;
    const G1_END = G1_START + 30 * ONE_MINUTE;

    // Range G2: T+15 to T+45 (Overlaps with G1)
    const G2_START = G1_START + 15 * ONE_MINUTE;
    const G2_END = G1_START + 45 * ONE_MINUTE;

    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');
    const storage = inject.storage() as SQLiteStorage;
    const db = storage['db'];

    // Import G1
    mockDaterange = { start: G1_START, end: G1_END };
    await gekkoPipeline();

    // Import G2
    mockDaterange = { start: G2_START, end: G2_END };
    await gekkoPipeline();

    // Total range should be G1_START to G2_END
    const totalCount = db.query('SELECT count(*) as count FROM candles_BTC_USDT WHERE start >= ? AND start <= ?').get(G1_START, G2_END) as {
      count: number;
    };

    // G1 is 0 to 30 (31 candles)
    // G2 is 15 to 45 (31 candles)
    // Combined is 0 to 45 (46 candles)
    expect(totalCount.count).toBe(46);
  }, 60000);

  it('Scenario G: Partial Gap Resilience', async () => {
    mockDaterange = { start: SCENARIO_G_START, end: SCENARIO_G_END };
    mockPairs = [
      { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' },
      { symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT' },
    ];

    // Configure Gap: 10 minute gap ONLY for ETH
    const GAP_START = SCENARIO_G_START + 25 * ONE_MINUTE;
    const GAP_END = SCENARIO_G_START + 35 * ONE_MINUTE;

    MockCCXTExchange.simulatedGaps = {
      'ETH/USDT': [{ start: GAP_START, end: GAP_END }],
    };

    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');

    // Re-initialize storage with new mockPairs
    inject.reset();
    const storage = inject.storage() as SQLiteStorage;
    storage.close = () => storage['flush']();
    const db = storage['db'];

    await gekkoPipeline();

    // Verify BTC (Should have all candles)
    const rowCountBTC = db
      .query('SELECT count(*) as count FROM candles_BTC_USDT WHERE start >= ? AND start <= ?')
      .get(SCENARIO_G_START, SCENARIO_G_END) as { count: number };
    expect(rowCountBTC.count).toBe(61);

    // Verify ETH (Should have all candles because gap is filled)
    const rowCountETH = db
      .query('SELECT count(*) as count FROM candles_ETH_USDT WHERE start >= ? AND start <= ?')
      .get(SCENARIO_G_START, SCENARIO_G_END) as { count: number };
    expect(rowCountETH.count).toBe(61);

    // Verify Filled Candle values for ETH
    // Get candle before gap
    const beforeGapETH = db.query('SELECT * FROM candles_ETH_USDT WHERE start = ?').get(GAP_START - ONE_MINUTE) as any;
    // Get candle in gap
    const gapCandleETH = db.query('SELECT * FROM candles_ETH_USDT WHERE start = ?').get(GAP_START) as any;

    expect(gapCandleETH.open).toBe(beforeGapETH.close);
    expect(gapCandleETH.high).toBe(beforeGapETH.close);
    expect(gapCandleETH.low).toBe(beforeGapETH.close);
    expect(gapCandleETH.close).toBe(beforeGapETH.close);
    expect(gapCandleETH.volume).toBe(0);
  }, 60000);

  it('Scenario H: Total Gap Resilience', async () => {
    mockDaterange = { start: SCENARIO_H_START, end: SCENARIO_H_END };
    mockPairs = [
      { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' },
      { symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT' },
    ];

    // Configure Gap: 10 minute gap for BOTH
    const GAP_START = SCENARIO_H_START + 25 * ONE_MINUTE;
    const GAP_END = SCENARIO_H_START + 35 * ONE_MINUTE;

    MockCCXTExchange.simulatedGaps = [
      { start: GAP_START, end: GAP_END }, // Global gap
    ];

    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');

    // Re-initialize storage with new mockPairs
    inject.reset();
    const storage = inject.storage() as SQLiteStorage;
    storage.close = () => storage['flush']();
    const db = storage['db'];

    await gekkoPipeline();

    // Verify BTC (Should have all candles)
    const rowCountBTC = db
      .query('SELECT count(*) as count FROM candles_BTC_USDT WHERE start >= ? AND start <= ?')
      .get(SCENARIO_H_START, SCENARIO_H_END) as { count: number };
    expect(rowCountBTC.count).toBe(61);

    // Verify ETH (Should have all candles)
    const rowCountETH = db
      .query('SELECT count(*) as count FROM candles_ETH_USDT WHERE start >= ? AND start <= ?')
      .get(SCENARIO_H_START, SCENARIO_H_END) as { count: number };
    expect(rowCountETH.count).toBe(61);

    // Verify BTC filled candle values
    const beforeGapBTC = db.query('SELECT * FROM candles_BTC_USDT WHERE start = ?').get(GAP_START - ONE_MINUTE) as any;
    const gapCandleBTC = db.query('SELECT * FROM candles_BTC_USDT WHERE start = ?').get(GAP_START) as any;

    expect(gapCandleBTC.open).toBe(beforeGapBTC.close);
    expect(gapCandleBTC.high).toBe(beforeGapBTC.close);
    expect(gapCandleBTC.low).toBe(beforeGapBTC.close);
    expect(gapCandleBTC.close).toBe(beforeGapBTC.close);
    expect(gapCandleBTC.volume).toBe(0);
  }, 60000);

  it('Scenario I: Leading Gap Resilience (gap at the start)', async () => {
    mockDaterange = { start: SCENARIO_I_START, end: SCENARIO_I_END };
    mockPairs = [{ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' }];

    // Configure Gap: 10 minute gap at the START of the range
    // Note: Gap is exclusive on the end, so candles from GAP_START to GAP_END-1 are missing
    const GAP_START = SCENARIO_I_START;
    const GAP_END = SCENARIO_I_START + 10 * ONE_MINUTE; // 10 candles missing

    MockCCXTExchange.simulatedGaps = [{ start: GAP_START, end: GAP_END }];

    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');
    const storage = inject.storage() as SQLiteStorage;
    const db = storage['db'];

    await gekkoPipeline();

    // The gap fill stream CANNOT fill leading gaps because there's no previous candle to reference.
    // Expected: 61 total - 10 missing at start = 51 candles
    const rowCountBTC = db
      .query('SELECT count(*) as count FROM candles_BTC_USDT WHERE start >= ? AND start <= ?')
      .get(SCENARIO_I_START, SCENARIO_I_END) as { count: number };
    expect(rowCountBTC.count).toBe(51); // 10 candles at lead are NOT filled

    // Verify first actual candle starts AFTER the gap
    const rows = db
      .query('SELECT * FROM candles_BTC_USDT WHERE start >= ? AND start <= ? ORDER BY start ASC')
      .all(SCENARIO_I_START, SCENARIO_I_END) as any[];
    const firstCandle = rows[0];

    // First candle should be at GAP_END (first candle after the gap)
    expect(firstCandle.start).toBe(GAP_END);

    // Confirm no candles exist in the gap range
    const gapCandles = db
      .query('SELECT count(*) as count FROM candles_BTC_USDT WHERE start >= ? AND start < ?')
      .get(GAP_START, GAP_END) as { count: number };
    expect(gapCandles.count).toBe(0);
  }, 60000);

  it('Scenario J: Trailing Gap Resilience (gap at the end)', async () => {
    mockDaterange = { start: SCENARIO_J_START, end: SCENARIO_J_END };
    mockPairs = [{ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' }];

    // Configure Gap: 10 minute gap at the END of the range
    // The mock gap filter uses exclusive end: c.start >= gap.start && c.start < gap.end
    // So we need GAP_END to be AFTER the last gap candle
    const GAP_START = SCENARIO_J_END - 9 * ONE_MINUTE; // First gap candle
    const GAP_END = SCENARIO_J_END + ONE_MINUTE; // This makes SCENARIO_J_END the last gap candle (exclusive)

    MockCCXTExchange.simulatedGaps = [{ start: GAP_START, end: GAP_END }];

    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');
    const storage = inject.storage() as SQLiteStorage;
    const db = storage['db'];

    await gekkoPipeline();

    // The gap fill stream CANNOT fill trailing gaps because there's no subsequent candle
    // to compare against and trigger the gap detection.
    // Expected: 61 total - 10 missing at end = 51 candles
    const rowCountBTC = db
      .query('SELECT count(*) as count FROM candles_BTC_USDT WHERE start >= ? AND start <= ?')
      .get(SCENARIO_J_START, SCENARIO_J_END) as { count: number };
    expect(rowCountBTC.count).toBe(51); // 10 candles at trail are NOT filled

    // Verify last actual candle is right before the gap starts
    const rows = db
      .query('SELECT * FROM candles_BTC_USDT WHERE start >= ? AND start <= ? ORDER BY start DESC')
      .all(SCENARIO_J_START, SCENARIO_J_END) as any[];
    const lastCandle = rows[0];

    // Last candle should be at GAP_START - ONE_MINUTE (last candle before the gap)
    expect(lastCandle.start).toBe(GAP_START - ONE_MINUTE);

    // Confirm no candles exist in the gap range
    const gapCandles = db
      .query('SELECT count(*) as count FROM candles_BTC_USDT WHERE start >= ? AND start < ?')
      .get(GAP_START, GAP_END) as { count: number };
    expect(gapCandles.count).toBe(0);
  }, 60000);

  // Scenarios K, L and M run on the real clock, against an exchange that serves candles up to the minute in progress (its
  // candle is not closed yet) and none after it, as Binance does. A minute that closes while the pipeline is built is imported.
  const minuteOf = (timestamp: number) => timestamp - (timestamp % ONE_MINUTE);
  const serveCandlesUpToTheMinuteInProgress = () => {
    MockCCXTExchange.simulatedGaps = [{ start: minuteOf(Date.now()) + 1, end: Infinity }];
  };

  it('Scenario K: daterange.end now (the candle in progress is not imported)', async () => {
    serveCandlesUpToTheMinuteInProgress();
    const lastClosedMinute = minuteOf(Date.now()) - ONE_MINUTE;
    const SCENARIO_K_START = lastClosedMinute - 30 * ONE_MINUTE;
    mockDaterange = { start: SCENARIO_K_START, end: Date.now() };
    mockPairs = [{ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' }];

    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');
    const storage = inject.storage() as SQLiteStorage;
    const db = storage['db'];

    await gekkoPipeline();
    const minuteInProgress = minuteOf(Date.now());

    const { firstStart, lastStart } = db
      .query('SELECT min(start) as firstStart, max(start) as lastStart FROM candles_BTC_USDT WHERE start >= ?')
      .get(SCENARIO_K_START) as { firstStart: number; lastStart: number };

    expect(firstStart).toBe(SCENARIO_K_START);
    expect(lastStart).toBeGreaterThanOrEqual(lastClosedMinute);
    expect(lastStart).toBeLessThan(minuteInProgress);
  }, 60000);

  it('Scenario L: daterange.end in the future (import stops at the last closed minute)', async () => {
    serveCandlesUpToTheMinuteInProgress();
    const lastClosedMinute = minuteOf(Date.now()) - ONE_MINUTE;
    const SCENARIO_L_START = lastClosedMinute - 30 * ONE_MINUTE;
    mockDaterange = { start: SCENARIO_L_START, end: Date.now() + 30 * ONE_MINUTE };
    mockPairs = [{ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' }];

    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');
    const storage = inject.storage() as SQLiteStorage;
    const db = storage['db'];

    await gekkoPipeline();
    const minuteInProgress = minuteOf(Date.now());

    const { firstStart, lastStart } = db
      .query('SELECT min(start) as firstStart, max(start) as lastStart FROM candles_BTC_USDT WHERE start >= ?')
      .get(SCENARIO_L_START) as { firstStart: number; lastStart: number };

    expect(firstStart).toBe(SCENARIO_L_START);
    expect(lastStart).toBeGreaterThanOrEqual(lastClosedMinute);
    expect(lastStart).toBeLessThan(minuteInProgress);
    expect(
      logStore.filter(isTextLine).some(({ level, message }) => level === 'warn' && message.includes('is not a closed minute yet')),
    ).toBe(true);
  }, 60000);

  it('Scenario M: daterange entirely in the future (nothing to import, ends cleanly)', async () => {
    serveCandlesUpToTheMinuteInProgress();
    const SCENARIO_M_START = Date.now() + 60 * ONE_MINUTE;
    mockDaterange = { start: SCENARIO_M_START, end: SCENARIO_M_START + 60 * ONE_MINUTE };
    mockPairs = [{ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' }];

    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    const { inject } = await import('@services/injecter/injecter');
    const storage = inject.storage() as SQLiteStorage;
    const db = storage['db'];

    await gekkoPipeline();

    const rowCountBTC = db.query('SELECT count(*) as count FROM candles_BTC_USDT').get() as { count: number };
    expect(rowCountBTC.count).toBe(0);
  }, 60000);
});
