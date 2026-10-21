import { ONE_MINUTE } from '@constants/time.const';
import type { RoundTrip } from '@models/event.types';
import type { DebugBacktestParams } from '@strategies/debug/debugBacktest.types';
import { beforeEach, describe, expect, it } from 'bun:test';
import { isObjectLike, range } from 'lodash-es';
import { rawDaterange, type RawConfiguration } from '../helpers/configuration.helper';
import { clearLogs, findLoggedObject, findTextLine, findTextLines, logStore } from '../mocks/winston.mock';
import {
  candleAt,
  candlesClosingAt,
  filledMarketOrder,
  minute,
  mockBacktestModules,
  openLimitOrder,
  rawMarket,
  runBacktest,
} from './backtestRun.helper';

mockBacktestModules();

/** The quote and the market of each asset a scenario can watch */
const MARKETS = {
  BTC: { price: 10000, amountMax: 1000 },
  ETH: { price: 2000, amountMax: 10000 },
};

/** What a scenario backtests: the assets, against USDT, from a balance of 300000 USDT; DebugBacktest trading 1 unit on its calendar */
type Backtest = {
  assets: (keyof typeof MARKETS)[];
  /** The minutes read, from the one `first` minutes after 00:00 to the one `last` minutes after it, both included */
  minutes: { first: number; last: number };
  analyzer: 'RoundTripAnalyzer' | 'PortfolioAnalyzer';
  /** DebugBacktest counts its candles from 0, the first after the warmup: from 00:00 on 1m without one, n is the candle of the minute n */
  calendar: DebugBacktestParams;
  timeframe?: '1m' | '5m';
  candleCount?: number;
  batchSize?: number;
  /** Binance's regular fee by default: 0.1 % for a maker (a LIMIT order) and for a taker (a MARKET order) */
  fee?: { maker: number; taker: number };
};

/** The configuration of a scenario, as its file would hold it */
const configurationOf = (backtest: Backtest): RawConfiguration => ({
  watch: {
    mode: 'backtest',
    assets: backtest.assets,
    currency: 'USDT',
    timeframe: backtest.timeframe ?? '1m',
    warmup: { candleCount: backtest.candleCount ?? 0 },
    // To the last millisecond of the last minute: a backtest reads each minute its range touches
    daterange: rawDaterange({ start: minute(backtest.minutes.first), end: minute(backtest.minutes.last + 1) - 1 }),
    batchSize: backtest.batchSize,
  },
  exchange: {
    name: 'dummy-cex',
    simulationBalance: [...backtest.assets.map(assetName => ({ assetName, balance: 0 })), { assetName: 'USDT', balance: 300000 }],
    initialTicker: backtest.assets.map(asset => ({
      symbol: `${asset}/USDT`,
      ticker: { bid: MARKETS[asset].price, ask: MARKETS[asset].price },
    })),
    marketData: backtest.assets.map(asset => rawMarket(`${asset}/USDT`, { amountMax: MARKETS[asset].amountMax, fee: backtest.fee })),
  },
  storage: { type: 'sqlite', database: ':memory:' },
  plugins: [
    { name: 'TradingAdvisor', strategyName: 'DebugBacktest' },
    { name: 'Trader' },
    { name: backtest.analyzer, enableConsoleTable: false },
  ],
  strategy: { name: 'DebugBacktest', ...backtest.calendar },
});

// --------------------------------------------------------------------------
// HELPERS
// --------------------------------------------------------------------------

/** The report the analyzer logged at the end of the run: the PortfolioAnalyzer logs the length of its equity curve, not the curve */
const loggedReport = (id: 'TRADING REPORT' | 'PORTFOLIO PROFIT REPORT') => findLoggedObject(message => message.id === id);

/** The round trips the RoundTripAnalyzer logged as they closed, oldest first: numbered from 0, where its report is named */
const loggedRoundTrips = () =>
  logStore.map(({ message }) => message).filter(message => isObjectLike(message) && typeof (message as RoundTrip).id === 'number');

// --------------------------------------------------------------------------
// TEST SUITE
// --------------------------------------------------------------------------

describe('E2E: Backtest Flow', () => {
  beforeEach(() => {
    clearLogs();
  });

  it('Scenario A: two round trips, the last SELL on the last candle read: net -40 of fees over 4 trades, 1 of 2 won', async () => {
    // BTC opens every minute at 10000 and closes there too, but on the minutes of the orders: the BUYs at 9000 (00:01) and 11000 (00:05),
    // the SELLs at 11000 (00:03) and 9000 (00:08). Each high and low is 100 above and below the close. The 9 candles are all read.
    const candles = candlesClosingAt({ 1: 9000, 3: 11000, 5: 11000, 8: 9000 });

    const { failure, orderCalls } = await runBacktest(
      configurationOf({
        assets: ['BTC'],
        minutes: { first: 0, last: 8 },
        analyzer: 'RoundTripAnalyzer',
        calendar: { buyCandleIndex: [1, 5], sellCandleIndex: [3, 8] },
      }),
      { 'BTC/USDT': candles },
    );

    // Each MARKET order fills at the close of its candle, dated at its end, for a fee of 0.1 %: the BUY at 9000 costs 9009 and the one at
    // 11000 11011, the SELL at 11000 brings 10989 and the one at 9000 8991. The last fill is in the report only because it is delivered
    // with the bucket it fills in, the last one: nothing is flushed after the run.
    expect({ failure, orderCalls, report: loggedReport('TRADING REPORT'), roundTrips: loggedRoundTrips() }).toEqual({
      failure: undefined,
      orderCalls: [
        filledMarketOrder(minute(2), 'BTC/USDT', 'BUY', 1, 1),
        filledMarketOrder(minute(4), 'BTC/USDT', 'SELL', 1, 2),
        filledMarketOrder(minute(6), 'BTC/USDT', 'BUY', 1, 3),
        filledMarketOrder(minute(9), 'BTC/USDT', 'SELL', 1, 4),
      ],
      report: {
        id: 'TRADING REPORT',
        // From the close of the candle that completed the warmup, 00:00's, to that of the last candle read, 00:08's
        periodStartAt: minute(1),
        periodEndAt: minute(9),
        formattedDuration: '8 minutes',
        // The four fees: 9 + 11 + 11 + 9
        netProfit: -40,
        // The period is shorter than a day: annualized over a day, 1/366 of the year 2024, -40 × 366
        annualizedNetProfit: -14640,
        // -40 / 300000 × 100
        totalReturnPct: -0.0133333333333333,
        // -40 / 300000 × 100 × 366, from the equities: from the total return, rounded to 15 significant digits, -4.87999999999999
        annualizedReturnPct: -4.88,
        // From the close of 00:00, 10000, to that of 00:08, 9000
        marketReturnPct: -10,
        // -0.0133333333333333 - (-10)
        alpha: 9.986666666666666,
        // 5 of the 8 minutes in a round trip: 00:02 to 00:04, then 00:06 to 00:09
        exposurePct: 62.5,
        // The population standard deviation of the two profits, half their difference: (0.66 + 0.668918471421948) / 2
        volatility: 0.664459235710974,
        // The root mean square of the losses over both profits: √(0.668918471421948² / 2)
        downsideDeviation: 0.47299678720339927,
        // (annualizedReturnPct - 5, the risk-free return) / (the deviation × √(2 returns × 366 a year)): -9.88 over
        // 0.664459235710974 × √732, then over 0.47299678720339927 × √732
        sharpeRatio: -0.5495827106095078,
        sortinoRatio: -0.7720460640138034,
        startPrice: 10000,
        endPrice: 9000,
        startBalance: 300000,
        finalBalance: 299960,
        winRate: 50,
        topMAEs: [19.090909090909093, 0],
        tradeCount: 4,
      },
      roundTrips: [
        // The pair equity before the BUY, 290991 + 9000 + its fee 9, to the one after the SELL, 301980: 1980, 0.66 % of 300000. The
        // lows it reads, of the candles closing after its BUY, 00:02 and 00:03, never fall below 9000.
        {
          id: 0,
          symbol: 'BTC/USDT',
          entryAt: minute(2),
          entryPrice: 9000,
          entryEquity: 300000,
          exitAt: minute(4),
          exitPrice: 11000,
          exitEquity: 301980,
          pnl: 1980,
          profit: 0.66,
          maxAdverseExcursion: 0,
          duration: 2 * ONE_MINUTE,
        },
        // From 290969 + 11000 + 11 to 299960: -2020, -2020 / 301980 × 100. Its adverse excursion is the low of 00:08, 8900:
        // (11000 - 8900) / 11000 × 100.
        {
          id: 1,
          symbol: 'BTC/USDT',
          entryAt: minute(6),
          entryPrice: 11000,
          entryEquity: 301980,
          exitAt: minute(9),
          exitPrice: 9000,
          exitEquity: 299960,
          pnl: -2020,
          profit: -0.668918471421948,
          maxAdverseExcursion: 19.090909090909093,
          duration: 3 * ONE_MINUTE,
        },
      ],
    });
  });

  it('Scenario B: a round trip on each of BTC and ETH: net 2376 after 24 of fees, exposed 25 % of the period', async () => {
    // BTC closes at 9000 on 00:01 and 11000 on 00:03, 10000 otherwise, its high and low 100 off its close; ETH at 1800 and 2200, 2000
    // otherwise, 10 off. Both open every minute at their usual price. The 9 candles of each are all read.
    const { failure, orderCalls } = await runBacktest(
      configurationOf({
        assets: ['BTC', 'ETH'],
        minutes: { first: 0, last: 8 },
        analyzer: 'PortfolioAnalyzer',
        calendar: { buyCandleIndex: 1, sellCandleIndex: 3 },
      }),
      {
        'BTC/USDT': candlesClosingAt({ 1: 9000, 3: 11000 }),
        'ETH/USDT': candlesClosingAt({ 1: 1800, 3: 2200 }, { open: 2000, spread: 10, volume: 100 }),
      },
    );

    // The BUYs fill at 00:02 for 9009 and 1801.8, which leaves 289189.2 USDT; the SELLs at 00:04 bring 10989 and 2197.8, for 302376. The
    // equity curve has a point at the close of each candle, 00:01 to 00:09: 300000, 300000, then at 00:03 the positions at 10000 and
    // 2000, 301189.2, at 00:04 at 11000 and 2200, 302389.2, valued before the SELLs are heard, then 302376 to the end.
    expect({ failure, orderCalls, report: loggedReport('PORTFOLIO PROFIT REPORT') }).toEqual({
      failure: undefined,
      orderCalls: [
        filledMarketOrder(minute(2), 'BTC/USDT', 'BUY', 1, 1),
        filledMarketOrder(minute(2), 'ETH/USDT', 'BUY', 1, 2),
        filledMarketOrder(minute(4), 'BTC/USDT', 'SELL', 1, 3),
        filledMarketOrder(minute(4), 'ETH/USDT', 'SELL', 1, 4),
      ],
      report: {
        id: 'PORTFOLIO PROFIT REPORT',
        // From the close of the candle that completed the warmup, 00:00's, when the start prices and the start equity are taken
        periodStartAt: minute(1),
        periodEndAt: minute(9),
        formattedDuration: '8 minutes',
        // 2000 + 400 gross, less the fees 9 + 1.8 + 11 + 2.2
        netProfit: 2376,
        // Over a day, the horizon of a period shorter than one, 1/366 of the year 2024: 2376 × 366
        annualizedNetProfit: 869616,
        // 2376 / 300000 × 100
        totalReturnPct: 0.792,
        // 0.792 × 366
        annualizedReturnPct: 289.872,
        // The benchmark, BTC, closes 00:00 and 00:08 at 10000
        marketReturnPct: 0,
        alpha: 0.792,
        // The spans that end on a point holding the positions, 00:02 to 00:04: 2 of the 8 minutes
        exposurePct: 25,
        // The population standard deviation of the 8 returns of the curve: 0, 0.3964 (1189.2 / 300000 × 100), 0.39842066050177094
        // (1200 / 301189.2 × 100), -0.004365235266342727 (-13.2 / 302389.2 × 100), then four of 0
        volatility: 0.1724052513640046,
        // The root mean square of the one loss over the 8 returns: 0.004365235266342727 / √8
        downsideDeviation: 0.0015433437291528034,
        // (annualizedReturnPct - 5, the risk-free return) / (the deviation × √(8 returns × 366 a year)): 284.872 over
        // 0.1724052513640046 × √2928, then over 0.0015433437291528034 × √2928
        sharpeRatio: 30.536111898175253,
        sortinoRatio: 3411.155887077856,
        startPrice: 10000,
        endPrice: 10000,
        // The SELL fees from the peak of 00:04, 302389.2: 13.2 / 302389.2 × 100. The curve stays below it to the end, five minutes.
        maxDrawdownPct: 0.00436523526633888,
        longestDrawdownMs: 5 * ONE_MINUTE,
        startEquity: 300000,
        endEquity: 302376,
        // Delivered three times: the synchronizations at start-up and at the end of the warmup together, then after the BUYs, then
        // after the SELLs
        portfolioChangeCount: 3,
        benchmarkAsset: 'BTC',
        // One point per candle after the warmup, that which completed it included
        equityCurveLength: 9,
      },
    });
  });

  it('Scenario C: the synchronization of 00:10 reads the 9508.55 USDT a resting LIMIT BUY reserves, which fills at 00:13', async () => {
    // BTC trades at 10000 every minute, 100 either side, but for the low of 00:12, 9400: the first to reach the LIMIT BUY at 9500. The
    // 15 candles, 00:00 to 00:14, are all read.
    const candles = range(15).map(n => ({
      ...candleAt(n, { open: 10000, close: 10000, spread: 100, volume: 10 }),
      ...(n === 12 && { low: 9400 }),
    }));

    const { failure, orderCalls, balanceReads } = await runBacktest(
      configurationOf({
        assets: ['BTC'],
        minutes: { first: 0, last: 14 },
        analyzer: 'PortfolioAnalyzer',
        calendar: { buyCandleIndex: 2, sellCandleIndex: 14, buyLimitPrice: 9500 },
        // Binance's VIP 1 fees: the LIMIT BUY pays the maker fee, the MARKET SELL the taker fee
        fee: { maker: 0.0009, taker: 0.001 },
      }),
      { 'BTC/USDT': candles },
    );

    // The LIMIT BUY sent with the candle of 00:02 reserves its cost, 9500 × 1.0009 = 9508.55, and rests until the low of 00:12 reaches
    // it: it fills at 00:13, at its price. The MARKET SELL sent with the last candle brings 10000 × 0.999 = 9990.
    expect({ failure, orderCalls, report: loggedReport('PORTFOLIO PROFIT REPORT'), balanceReads }).toEqual({
      failure: undefined,
      orderCalls: [openLimitOrder(minute(3), 'BTC/USDT', 'BUY', 1, 9500, 1), filledMarketOrder(minute(15), 'BTC/USDT', 'SELL', 1, 2)],
      report: {
        id: 'PORTFOLIO PROFIT REPORT',
        periodStartAt: minute(1),
        periodEndAt: minute(15),
        formattedDuration: '14 minutes',
        // 9990 - 9508.55: bought 500 below the market, less 8.55 and 10 of fees
        netProfit: 481.45,
        // 481.45 × 366, over a day of 2024
        annualizedNetProfit: 176210.7,
        // 481.45 / 300000 × 100
        totalReturnPct: 0.160483333333333,
        // 481.45 / 300000 × 100 × 366
        annualizedReturnPct: 58.7369,
        marketReturnPct: 0,
        alpha: 0.160483333333333,
        // The spans that end on a point holding BTC, 00:13 to 00:15: 2 of the 14 minutes, the point of 00:13 being marked before the
        // fill of that bucket is heard
        exposurePct: 14.2857142857143,
        // The curve holds 300000 to 00:13, the reservation counted in the total, then 300491.45 at 00:14, BTC at 10000, and 300481.45 at
        // 00:15, after the SELL. Its 14 returns are twelve of 0, 0.16381666666667055 (491.45 / 300000 × 100) and -0.003327881708447944
        // (-10 / 300491.45 × 100): their population standard deviation, and the root mean square of the loss over them
        volatility: 0.04226380953791824,
        downsideDeviation: 0.0008894137983374381,
        // 53.7369, the annualized return less the risk-free 5, over each deviation × √(14 returns × 366 a year)
        sharpeRatio: 17.762308468998818,
        sortinoRatio: 844.0422483784157,
        startPrice: 10000,
        endPrice: 10000,
        // The fee of the SELL from the peak of 00:14: 10 / 300491.45 × 100, the last minute
        maxDrawdownPct: 0.00332788170844794,
        longestDrawdownMs: ONE_MINUTE,
        startEquity: 300000,
        endEquity: 300481.45,
        // The start-up and the end of the warmup, delivered together, the synchronization of 00:10, then those after the BUY and the SELL
        portfolioChangeCount: 4,
        benchmarkAsset: 'BTC',
        equityCurveLength: 15,
      },
      // The Trader synchronizes at start-up, at the end of the warmup, at the end of each order and, in a backtest, on the minutes that are
      // a multiple of 10, or of the timeframe if longer, never on the first bucket: at 00:10, while the BUY rests, the read shows what it
      // reserves. Each read is dated by the simulator's clock, the close of the last candle it processed.
      balanceReads: [
        // The TradingAdvisor's and the Trader's, at start-up
        { at: minute(0), balance: { BTC: { free: 0, used: 0, total: 0 }, USDT: { free: 300000, used: 0, total: 300000 } } },
        { at: minute(0), balance: { BTC: { free: 0, used: 0, total: 0 }, USDT: { free: 300000, used: 0, total: 300000 } } },
        // At the end of the warmup, the candle of 00:00
        { at: minute(1), balance: { BTC: { free: 0, used: 0, total: 0 }, USDT: { free: 300000, used: 0, total: 300000 } } },
        // The periodic synchronization of 00:10, the BUY resting
        { at: minute(11), balance: { BTC: { free: 0, used: 0, total: 0 }, USDT: { free: 290491.45, used: 9508.55, total: 300000 } } },
        // After the BUY filled with the candle of 00:12
        { at: minute(13), balance: { BTC: { free: 1, used: 0, total: 1 }, USDT: { free: 290491.45, used: 0, total: 290491.45 } } },
        // After the SELL filled with the candle of 00:14
        { at: minute(15), balance: { BTC: { free: 0, used: 0, total: 0 }, USDT: { free: 300481.45, used: 0, total: 300481.45 } } },
      ],
    });
  });

  it('Scenario D: on 5-minute candles after a warmup of two, from 00:03, the strategy trades the candles of 00:20 and 00:30', async () => {
    // BTC closes 10 higher every minute, at 10000 + 10 × n on the minute n minutes after 00:00, its open there too and its high and low
    // 50 off: the minutes 00:03 to 00:34 are read, in batches of 10 minutes.
    const candles = range(3, 35).map(n => candleAt(n, { open: 10000 + 10 * n, close: 10000 + 10 * n, spread: 50, volume: 10 }));

    const { failure, orderCalls } = await runBacktest(
      configurationOf({
        assets: ['BTC'],
        minutes: { first: 3, last: 34 },
        analyzer: 'RoundTripAnalyzer',
        calendar: { buyCandleIndex: 1, sellCandleIndex: 3 },
        timeframe: '5m',
        candleCount: 2,
        batchSize: 10,
      }),
      { 'BTC/USDT': candles },
    );

    // The minutes 00:03 and 00:04 come before the first 5-minute boundary and are skipped: the strategy sees six 5-minute candles, from
    // 00:05 to 00:30. Those of 00:05 and 00:10 are the warmup, that of 00:15 completes it: DebugBacktest counts it 0, buys on 1, the
    // candle of 00:20, which closes at 10240 with the minute 00:24, and sells on 3, that of 00:30, at 10340 with the minute 00:34, the
    // last read.
    expect({
      failure,
      orderCalls,
      skipped: findTextLines('Skipped', 'warn').map(({ message }) => message),
      warmup: findTextLine('Strategy warmup done', 'info')?.message,
      report: loggedReport('TRADING REPORT'),
      roundTrips: loggedRoundTrips(),
    }).toEqual({
      failure: undefined,
      orderCalls: [filledMarketOrder(minute(25), 'BTC/USDT', 'BUY', 1, 1), filledMarketOrder(minute(35), 'BTC/USDT', 'SELL', 1, 2)],
      skipped: [
        'Skipped 2 one-minute candles from 2024-01-01T00:03:00.000Z: the first 5-minute candle starts on the first boundary, 2024-01-01T00:05:00.000Z',
      ],
      warmup: 'Strategy warmup done ! Sending first candle bucket (2024-01-01T00:15:00.000Z) to strategy',
      report: {
        id: 'TRADING REPORT',
        // From the close of the candle that completed the warmup, the 00:15 candle's at 00:20, to the end of the last minute read
        periodStartAt: minute(20),
        periodEndAt: minute(35),
        formattedDuration: '15 minutes',
        // 10340 × 0.999 - 10240 × 1.001: 10329.66 - 10250.24
        netProfit: 79.42,
        // 79.42 × 366, over a day of 2024
        annualizedNetProfit: 29067.72,
        // 79.42 / 300000 × 100
        totalReturnPct: 0.0264733333333333,
        // 79.42 / 300000 × 100 × 366
        annualizedReturnPct: 9.68924,
        // From the close of the 00:15 candle, 10190, to the last, 10340: 150 / 10190 × 100
        marketReturnPct: 1.4720314033366,
        // 0.0264733333333333 - 1.4720314033366
        alpha: -1.4455580700032666,
        // The round trip, 00:25 to 00:35: 10 of the 15 minutes
        exposurePct: 66.6666666666667,
        // A single profit, which deviates from nothing: no ratio either
        volatility: 0,
        downsideDeviation: 0,
        sharpeRatio: 0,
        sortinoRatio: 0,
        startPrice: 10190,
        endPrice: 10340,
        startBalance: 300000,
        finalBalance: 300079.42,
        winRate: 100,
        topMAEs: [0.390625],
        tradeCount: 2,
      },
      // The adverse excursion reads the one-minute candles that close after the BUY filled, 00:25 to 00:34: the lowest low is the first,
      // 10200, (10240 - 10200) / 10240 × 100
      roundTrips: [
        {
          id: 0,
          symbol: 'BTC/USDT',
          entryAt: minute(25),
          entryPrice: 10240,
          entryEquity: 300000,
          exitAt: minute(35),
          exitPrice: 10340,
          exitEquity: 300079.42,
          pnl: 79.42,
          profit: 0.0264733333333333,
          maxAdverseExcursion: 0.390625,
          duration: 10 * ONE_MINUTE,
        },
      ],
    });
  });
});
