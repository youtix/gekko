import type { SQLiteStorage } from '@services/storage/sqlite.storage';
import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { cleanDatabase, seedDatabaseWithCandles } from '../helpers/database.helper';
import { createCcxtModuleMock, MockCCXTExchange } from '../mocks/ccxt.mock';

import { MockFetcherService } from '../mocks/fetcher.mock';
import { MockHeart } from '../mocks/heart.mock';
import { MockWinston, clearLogs, logStore } from '../mocks/winston.mock';

// --------------------------------------------------------------------------
// MOCKS SETUP
// --------------------------------------------------------------------------
// DebugBacktest counts its candles from 0, the first after the warmup: with no warmup, index i is the candle seeded at i
const DEFAULT_MOCK_STRATEGY_CONFIG = { name: 'DebugBacktest', buyCandleIndex: 1, sellCandleIndex: 4 };
const DEFAULT_MOCK_STRATEGY_NAME = 'DebugBacktest';

const TARGET_CANDLES = 10;

// 1. Mock Winston
mock.module('winston', () => MockWinston);

// 3. Mock Fetcher
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
const startDate = new Date('2024-01-01T00:00:00Z').getTime();
const endDate = startDate + (TARGET_CANDLES - 1) * 60 * 1000; // 10 candles total (0 to 9)

let mockPairs = [{ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' }];
let mockStrategyConfig: any = DEFAULT_MOCK_STRATEGY_CONFIG;
let mockStrategyName = DEFAULT_MOCK_STRATEGY_NAME;

mock.module('@services/configuration/configuration', () => {
  return {
    config: {
      getWatch: () => ({
        mode: 'backtest',
        pairs: mockPairs,
        timeframe: '1m',
        tickrate: 100,
        warmup: { candleCount: 0 },
        assets: mockPairs.map(p => p.base),
        currency: 'USDT',
        daterange: { start: startDate, end: endDate - 1 },
        batchSize: 1440,
      }),
      showLogo: () => false,
      getExchange: () => ({
        name: 'dummy-cex',
        verbose: false,
        simulationBalance: new Map([
          ['BTC', 0],
          ['ETH', 0],
          ['USDT', 300000],
        ]),
        initialTicker: new Map([
          ['BTC/USDT', { bid: 10000, ask: 10000 }],
          ['ETH/USDT', { bid: 2000, ask: 2000 }],
        ]),
        marketData: new Map([
          [
            'BTC/USDT',
            {
              price: { min: 0, max: 1000000 },
              amount: { min: 0, max: 1000 },
              cost: { min: 0, max: 1000000 },
              precision: { price: 0.01, amount: 0.000001 },
              fee: { maker: 0.001, taker: 0.001 },
            },
          ],
          [
            'ETH/USDT',
            {
              price: { min: 0, max: 1000000 },
              amount: { min: 0, max: 10000 },
              cost: { min: 0, max: 1000000 },
              precision: { price: 0.01, amount: 0.000001 },
              fee: { maker: 0.001, taker: 0.001 },
            },
          ],
        ]),
        exchangeSynchInterval: 10 * 60 * 1000,
      }),
      getStorage: () => ({
        type: 'sqlite',
        database: ':memory:', // Isolated DB
      }),
      getPlugins: () => {
        const analyzers =
          mockPairs.length === 1
            ? [{ name: 'RoundTripAnalyzer', enableConsoleTable: false }]
            : [{ name: 'PortfolioAnalyzer', enableConsoleTable: false }];
        return [{ name: 'TradingAdvisor', strategyName: mockStrategyName }, { name: 'Trader' }, ...analyzers];
      },
      getStrategy: () => mockStrategyConfig,
    },
  };
});

// 5. Mock CCXT Library

mock.module('ccxt', () => createCcxtModuleMock());

// 7. Mock Heart
mock.module('@services/core/heart/heart', () => ({
  Heart: MockHeart,
}));

// --------------------------------------------------------------------------
// TEST SUITE
// --------------------------------------------------------------------------

describe('E2E: Backtest Flow', () => {
  let storage: SQLiteStorage;

  beforeEach(async () => {
    // Reset inject singletons
    const { inject } = await import('@services/injecter/injecter');
    inject.reset();

    // Clean DB
    storage = inject.storage() as SQLiteStorage;
    cleanDatabase(storage);
    clearLogs();

    // Reset mocks
    MockFetcherService.reset();

    let getCallCount = 0;
    MockFetcherService.when('getUpdates').thenReturn(() => {
      if (++getCallCount === 1) return subscriptionResponse;
      return { ok: true, result: [] };
    });

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
  it('Scenario A: Complex PnL with Multiple Trades', async () => {
    // Override the mock strategy config for this test
    mockStrategyConfig = { name: 'DebugBacktest', buyCandleIndex: [1, 5], sellCandleIndex: [3, 7] };

    // 1. Seed Database with 10 exact candles
    // Trade 1: Buy at 9000 (candle 1), Sell at 11000 (candle 3) => Win (Profit: 2000)
    // Trade 2: Buy at 11000 (candle 5), Sell at 9000 (candle 7) => Loss (Profit: -2000)
    // Net profit should be 0, Trade count: 2, Win rate: 50%
    const mockCandles = Array.from({ length: TARGET_CANDLES }).map((_, i) => {
      const time = startDate + i * 60 * 1000;
      const open = 10000;
      let startPrice = 10000;

      if (i === 1) startPrice = 9000; // BUY 1 here
      if (i === 3) startPrice = 11000; // SELL 1 here
      if (i === 5) startPrice = 11000; // BUY 2 here
      if (i === 7) startPrice = 9000; // SELL 2 here

      return {
        open,
        high: startPrice + 100,
        low: startPrice - 100,
        close: startPrice,
        volume: 10,
        start: time,
      };
    });
    seedDatabaseWithCandles(storage, 'BTC/USDT', mockCandles);

    // 2. Start Pipeline
    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');

    storage.close = () => {};

    const pipelinePromise = gekkoPipeline();
    await Promise.race([pipelinePromise]);

    // 3. Assert on final report logs
    const isObject = (value: unknown) => typeof value === 'object' && value !== null;
    const isFinalReport = (value: unknown) => isObject(value) && 'id' in value && value.id === 'TRADING REPORT';
    const roundtripPayload = logStore.find(log => isFinalReport(log.message));
    expect(roundtripPayload).toBeDefined();

    const report = roundtripPayload!.message as any;

    expect(report.startPrice).toBe(10000);
    expect(report.endPrice).toBe(10000);
    expect(report.netProfit).toBe(-40); // 2000 profit - 2000 loss - 40 fees
    expect(report.tradeCount).toBe(4);
    expect(report.winRate).toBe(50);
    expect(report.exposurePct).toBeGreaterThan(0);
    expect(report.exposurePct).toBeLessThan(100);
    expect(report.topMAEs).toBeDefined();
    expect(report.topMAEs.length).toBeGreaterThanOrEqual(1); // Should have MAEs
    expect(report.startBalance).toBe(300000); // from our mock exchange definition, USDT=300000
    // finalBalance should be 300000 considering 0 total profit, minus fees 40 = 299960
    expect(report.finalBalance).toBeCloseTo(299960, 0); // close to
  });

  it('Scenario B: Multi-Asset Concurrency', async () => {
    // We update mockPairs to have two assets.
    mockPairs = [
      { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' },
      { symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT' },
    ];
    // Override the mock strategy config for this test: buy on 1, sell on 3
    mockStrategyConfig = { name: 'DebugBacktest', buyCandleIndex: 1, sellCandleIndex: 3 };

    // 1. Seed Database with 10 exact candles for BTC/USDT
    // Trade: Buy at 9000 (candle 1), Sell at 11000 (candle 3) => Win (Profit: 2000)
    const mockCandlesBTC = Array.from({ length: TARGET_CANDLES }).map((_, i) => {
      const time = startDate + i * 60 * 1000;
      let startPrice = 10000;
      if (i === 1) startPrice = 9000; // BUY 1 here
      if (i === 3) startPrice = 11000; // SELL 1 here
      return { open: 10000, high: startPrice + 100, low: startPrice - 100, close: startPrice, volume: 10, start: time };
    });
    seedDatabaseWithCandles(storage, 'BTC/USDT', mockCandlesBTC);

    // 2. Seed Database with 10 exact candles for ETH/USDT
    // Trade: Buy at 1800 (candle 1), Sell at 2200 (candle 3) => Win (Profit: 400)
    const mockCandlesETH = Array.from({ length: TARGET_CANDLES }).map((_, i) => {
      const time = startDate + i * 60 * 1000;
      let startPrice = 2000;
      if (i === 1) startPrice = 1800; // BUY 1 here
      if (i === 3) startPrice = 2200; // SELL 1 here
      return { open: 2000, high: startPrice + 10, low: startPrice - 10, close: startPrice, volume: 100, start: time };
    });
    seedDatabaseWithCandles(storage, 'ETH/USDT', mockCandlesETH);

    // 3. Start Pipeline
    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');

    storage.close = () => {};

    const pipelinePromise = gekkoPipeline();
    await Promise.race([pipelinePromise]);

    // 4. Assert on final report logs
    // Because the Trading Advisor triggers orders for all processed symbols, we should have combined PnL
    const isObject = (value: unknown) => typeof value === 'object' && value !== null;
    const isFinalReport = (value: unknown) => isObject(value) && 'id' in value && value.id === 'PORTFOLIO PROFIT REPORT';
    const portfolioPayload = logStore.find(log => isFinalReport(log.message));
    expect(portfolioPayload).toBeDefined();

    const report = portfolioPayload!.message as any;

    // BTC profit ≈ 2000, ETH profit ≈ 400. Total gross ≈ 2400.
    // Fees are deducted. Net profit should be 2376.
    expect(report.id).toBe('PORTFOLIO PROFIT REPORT');
    expect(report.alpha).toBeCloseTo(0.792, 2);
    expect(report.downsideDeviation).toBeGreaterThan(0);
    expect(report.periodEndAt).toBe(1704067740000);
    // The close of the minute that completed the warmup (00:00), when the start prices and the start equity are taken
    expect(report.periodStartAt).toBe(1704067260000);
    // BTC and ETH are held for 2 of the 8 minutes of the period: from the BUYs, heard at 00:02, to the SELLs, heard at 00:04
    expect(report.exposurePct).toBe(25);
    expect(report.marketReturnPct).toBe(0);
    expect(report.netProfit).toBe(2376);
    expect(report.totalReturnPct).toBeCloseTo(0.792, 2);
    // Annualized over a day, the minimum horizon, in a leap year: 366 such days
    expect(report.annualizedReturnPct).toBeCloseTo(0.792 * 366, 2);
    expect(report.sharpeRatio).toBeGreaterThan(0);
    expect(report.sortinoRatio).toBeGreaterThan(0);
    expect(report.volatility).toBeGreaterThan(0);
    expect(report.startPrice).toBe(10000);
    expect(report.endPrice).toBe(10000);
    expect(report.formattedDuration).toBe('8 minutes');
    expect(report.annualizedNetProfit).toBeCloseTo(2376 * 366, 0);
    // The log carries the length of the equity curve, not the curve
    expect(report.equityCurveLength).toBeGreaterThan(0);
    expect(report.maxDrawdownPct).toBeGreaterThan(0);
    // The curve has one point per close from 00:01 to 00:09. The peak is the 00:04 point, which values the positions at that close
    // before the SELLs are heard; the SELL fees keep every later point below it until the end of the period: five minutes.
    expect(report.longestDrawdownMs).toBe(300000);
    expect(report.startEquity).toBe(300000);
    expect(report.endEquity).toBe(302376);
    expect(report.portfolioChangeCount).toBeGreaterThanOrEqual(3);
    expect(report.benchmarkAsset).toBe('BTC');
  });
});
