import { ONE_MINUTE } from '@constants/time.const';
import type { SQLiteStorage } from '@services/storage/sqlite.storage';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { mockConfiguration, rawDaterange, type RawConfiguration } from '../helpers/configuration.helper';
import { seedDatabaseWithCandles } from '../helpers/database.helper';
import { createCcxtModuleMock } from '../mocks/ccxt.mock';
import { MockWinston, clearLogs, findLoggedObject } from '../mocks/winston.mock';

// --------------------------------------------------------------------------
// MOCKS SETUP
// --------------------------------------------------------------------------
const TARGET_CANDLES = 10;

// 1. Mock Winston
mock.module('winston', () => MockWinston);

// 2. Mock CCXT Library: a backtest builds no exchange client, but the injecter loads ccxt with CCXTExchange, and the mock spares this
// flow the load of the real one (backtestMissingCandles.flow.test.ts loads it)
mock.module('ccxt', () => createCcxtModuleMock());

// 3. Mock Configuration
const startDate = new Date('2024-01-01T00:00:00Z').getTime();
const endDate = startDate + (TARGET_CANDLES - 1) * ONE_MINUTE; // 10 candles total (0 to 9)

/** The quote and the market of each asset a scenario can watch */
const MARKETS = {
  BTC: { price: 10000, amountMax: 1000 },
  ETH: { price: 2000, amountMax: 10000 },
};

let mockAssets: (keyof typeof MARKETS)[] = ['BTC'];
// DebugBacktest counts its candles from 0, the first after the warmup: with no warmup, index i is the candle seeded at i
let mockStrategyConfig: RawConfiguration['strategy'];

mockConfiguration(() => ({
  watch: {
    mode: 'backtest',
    assets: mockAssets,
    currency: 'USDT',
    timeframe: '1m',
    tickrate: 100,
    warmup: { candleCount: 0 },
    daterange: rawDaterange({ start: startDate, end: endDate - 1 }),
    batchSize: 1440,
  },
  exchange: {
    name: 'dummy-cex',
    simulationBalance: [...mockAssets.map(assetName => ({ assetName, balance: 0 })), { assetName: 'USDT', balance: 300000 }],
    initialTicker: mockAssets.map(asset => ({ symbol: `${asset}/USDT`, ticker: { bid: MARKETS[asset].price, ask: MARKETS[asset].price } })),
    marketData: mockAssets.map(asset => ({
      symbol: `${asset}/USDT`,
      marketData: {
        price: { min: 0, max: 1000000 },
        amount: { min: 0, max: MARKETS[asset].amountMax },
        cost: { min: 0, max: 1000000 },
        precision: { price: 2, amount: 6 },
        fee: { maker: 0.001, taker: 0.001 },
      },
    })),
  },
  storage: { type: 'sqlite', database: ':memory:' },
  plugins: [
    { name: 'TradingAdvisor', strategyName: 'DebugBacktest' },
    { name: 'Trader' },
    mockAssets.length === 1
      ? { name: 'RoundTripAnalyzer', enableConsoleTable: false }
      : { name: 'PortfolioAnalyzer', enableConsoleTable: false },
  ],
  strategy: mockStrategyConfig,
}));

// --------------------------------------------------------------------------
// TEST SUITE
// --------------------------------------------------------------------------

describe('E2E: Backtest Flow', () => {
  let storage: SQLiteStorage;

  beforeEach(async () => {
    // Reset config defaults
    mockAssets = ['BTC'];

    // Reset inject singletons
    const { inject } = await import('@services/injecter/injecter');
    inject.reset();
    storage = inject.storage() as SQLiteStorage;
    clearLogs();
  });
  it('Scenario A: Complex PnL with Multiple Trades', async () => {
    // Override the mock strategy config for this test
    mockStrategyConfig = { name: 'DebugBacktest', buyCandleIndex: [1, 5], sellCandleIndex: [3, 7] };

    // 1. Seed Database with 10 exact candles
    // Trade 1: Buy at 9000 (candle 1), Sell at 11000 (candle 3) => Win (Profit: 2000)
    // Trade 2: Buy at 11000 (candle 5), Sell at 9000 (candle 7) => Loss (Profit: -2000)
    // Net profit should be 0, Trade count: 2, Win rate: 50%
    const mockCandles = Array.from({ length: TARGET_CANDLES }).map((_, i) => {
      const time = startDate + i * ONE_MINUTE;
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
    await gekkoPipeline();

    // 3. Assert on final report logs
    const report = findLoggedObject(message => message.id === 'TRADING REPORT')!;
    expect(report).toBeDefined();

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
    // We update the watched assets to have two.
    mockAssets = ['BTC', 'ETH'];
    // Override the mock strategy config for this test: buy on 1, sell on 3
    mockStrategyConfig = { name: 'DebugBacktest', buyCandleIndex: 1, sellCandleIndex: 3 };

    // 1. Seed Database with 10 exact candles for BTC/USDT
    // Trade: Buy at 9000 (candle 1), Sell at 11000 (candle 3) => Win (Profit: 2000)
    const mockCandlesBTC = Array.from({ length: TARGET_CANDLES }).map((_, i) => {
      const time = startDate + i * ONE_MINUTE;
      let startPrice = 10000;
      if (i === 1) startPrice = 9000; // BUY 1 here
      if (i === 3) startPrice = 11000; // SELL 1 here
      return { open: 10000, high: startPrice + 100, low: startPrice - 100, close: startPrice, volume: 10, start: time };
    });
    seedDatabaseWithCandles(storage, 'BTC/USDT', mockCandlesBTC);

    // 2. Seed Database with 10 exact candles for ETH/USDT
    // Trade: Buy at 1800 (candle 1), Sell at 2200 (candle 3) => Win (Profit: 400)
    const mockCandlesETH = Array.from({ length: TARGET_CANDLES }).map((_, i) => {
      const time = startDate + i * ONE_MINUTE;
      let startPrice = 2000;
      if (i === 1) startPrice = 1800; // BUY 1 here
      if (i === 3) startPrice = 2200; // SELL 1 here
      return { open: 2000, high: startPrice + 10, low: startPrice - 10, close: startPrice, volume: 100, start: time };
    });
    seedDatabaseWithCandles(storage, 'ETH/USDT', mockCandlesETH);

    // 3. Start Pipeline
    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
    await gekkoPipeline();

    // 4. Assert on final report logs
    // Because the Trading Advisor triggers orders for all processed symbols, we should have combined PnL
    const report = findLoggedObject(message => message.id === 'PORTFOLIO PROFIT REPORT')!;
    expect(report).toBeDefined();

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
