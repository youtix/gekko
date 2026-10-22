import { ONE_MINUTE } from '@constants/time.const';
import type { RoundTrip } from '@models/event.types';
import type { DebugBacktestParams } from '@strategies/debug/debugBacktest.types';
import type { DebugPositionBookParams } from '@strategies/debug/debugPositionBook.types';
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

/**
 * What a scenario backtests: the assets, against USDT, from a balance of `usdt` USDT, 300000 unless given; DebugBacktest trading 1 unit
 * of every pair on its calendar, or DebugPositionBook playing its steps, each on the pairs it names, through a position book as the
 * signal strategies trade
 */
type Backtest = {
  assets: (keyof typeof MARKETS)[];
  /** The minutes read, from the one `first` minutes after 00:00 to the one `last` minutes after it, both included */
  minutes: { first: number; last: number };
  analyzer: 'RoundTripAnalyzer' | 'PortfolioAnalyzer';
  timeframe?: '1m' | '5m';
  candleCount?: number;
  batchSize?: number;
  /** Binance's regular fee by default: 0.1 % for a maker (a LIMIT order) and for a taker (a MARKET order) */
  fee?: { maker: number; taker: number };
  usdt?: number;
} & (
  | {
      /**
       * DebugBacktest counts its candles from 0, the first after the warmup: from 00:00 on 1m without one, n is the candle of the
       * minute n
       */
      calendar: DebugBacktestParams;
    }
  | {
      /** DebugPositionBook counts its candles as DebugBacktest does: a BUY step takes the share of the currency the book gives it */
      steps: DebugPositionBookParams['steps'];
    }
);

/** The configuration of a scenario, as its file would hold it */
const configurationOf = (backtest: Backtest): RawConfiguration => {
  const strategy =
    'steps' in backtest ? { name: 'DebugPositionBook', steps: backtest.steps } : { name: 'DebugBacktest', ...backtest.calendar };
  return {
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
      simulationBalance: [
        ...backtest.assets.map(assetName => ({ assetName, balance: 0 })),
        { assetName: 'USDT', balance: backtest.usdt ?? 300000 },
      ],
      initialTicker: backtest.assets.map(asset => ({
        symbol: `${asset}/USDT`,
        ticker: { bid: MARKETS[asset].price, ask: MARKETS[asset].price },
      })),
      marketData: backtest.assets.map(asset => rawMarket(`${asset}/USDT`, { amountMax: MARKETS[asset].amountMax, fee: backtest.fee })),
    },
    storage: { type: 'sqlite', database: ':memory:' },
    plugins: [
      { name: 'TradingAdvisor', strategyName: strategy.name },
      { name: 'Trader' },
      { name: backtest.analyzer, enableConsoleTable: false },
    ],
    strategy,
  };
};

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
        // BTC, watched: the asset the market return is measured on
        benchmarkAsset: 'BTC',
        // The value of the portfolio, BTC at its close: USDT alone at both ends
        startBalance: 300000,
        finalBalance: 299960,
        winRate: 50,
        topMAEs: [19.090909090909093, 0],
        tradeCount: 4,
        // Its one pair: both round trips, their P&L added up, 1980 - 2020, and the exposure and the deepest MAE of the report
        pairs: [
          {
            symbol: 'BTC/USDT',
            roundTripCount: 2,
            winCount: 1,
            winRate: 50,
            tradeCount: 4,
            pnl: -40,
            exposurePct: 62.5,
            maxAdverseExcursion: 19.090909090909093,
          },
        ],
      },
      roundTrips: [
        // Its own fills: 1 BTC bought at 9000 and sold at 11000, less the fees of both, 9 and 11: 1980, 0.66 % of the 300000 the
        // portfolio was worth before the BUY, the 290991 USDT left after it, 1 BTC at its price and its fee. The lows it reads, of the
        // candles closing after its BUY, 00:02 and 00:03, never fall below 9000.
        {
          id: 0,
          symbol: 'BTC/USDT',
          entryAt: minute(2),
          entryPrice: 9000,
          entryEquity: 300000,
          exitAt: minute(4),
          exitPrice: 11000,
          cost: 9000,
          proceeds: 11000,
          fees: 20,
          pnl: 1980,
          profit: 0.66,
          maxAdverseExcursion: 0,
          duration: 2 * ONE_MINUTE,
        },
        // Bought at 11000 and sold at 9000, less the fees 11 and 9: -2020, of the 301980 the portfolio was worth before the BUY,
        // 290969 + 11000 + 11: -2020 / 301980 × 100. Its adverse excursion is the low of 00:08, 8900: (11000 - 8900) / 11000 × 100.
        {
          id: 1,
          symbol: 'BTC/USDT',
          entryAt: minute(6),
          entryPrice: 11000,
          entryEquity: 301980,
          exitAt: minute(9),
          exitPrice: 9000,
          cost: 11000,
          proceeds: 9000,
          fees: 20,
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
        benchmarkAsset: 'BTC',
        startBalance: 300000,
        finalBalance: 300079.42,
        winRate: 100,
        topMAEs: [0.390625],
        tradeCount: 2,
        pairs: [
          {
            symbol: 'BTC/USDT',
            roundTripCount: 1,
            winCount: 1,
            winRate: 100,
            tradeCount: 2,
            pnl: 79.42,
            exposurePct: 66.6666666666667,
            maxAdverseExcursion: 0.390625,
          },
        ],
      },
      // Bought at 10240 and sold at 10340, less the fees 10.24 and 10.34: 79.42, of the 300000 the portfolio was worth before the BUY,
      // 289749.76 USDT left after it, 1 BTC at 10240 and its fee. The adverse excursion reads the one-minute candles that close after the
      // BUY filled, 00:25 to 00:34: the lowest low is the first, 10200, (10240 - 10200) / 10240 × 100.
      roundTrips: [
        {
          id: 0,
          symbol: 'BTC/USDT',
          entryAt: minute(25),
          entryPrice: 10240,
          entryEquity: 300000,
          exitAt: minute(35),
          exitPrice: 10340,
          cost: 10240,
          proceeds: 10340,
          fees: 20.58,
          pnl: 79.42,
          profit: 0.0264733333333333,
          maxAdverseExcursion: 0.390625,
          duration: 10 * ONE_MINUTE,
        },
      ],
    });
  });

  it('Scenario E: overlapping round trips on BTC and ETH, ETH in and out first: numbered as they close, exposed for their union, 50 %', async () => {
    // BTC opens every minute at 10000 and closes there too, but at 9500 on 00:05 and 9800 on 00:08, its high and low 100 off its close;
    // ETH at 2000, but at 2100 on 00:02 and 2200 on 00:03, 10 off. The 9 candles of each are all read.
    const { failure, orderCalls } = await runBacktest(
      configurationOf({
        assets: ['BTC', 'ETH'],
        minutes: { first: 0, last: 8 },
        analyzer: 'RoundTripAnalyzer',
        usdt: 400000,
        steps: [
          { candle: 1, side: 'BUY', symbols: ['ETH/USDT'] },
          { candle: 2, side: 'BUY', symbols: ['BTC/USDT'] },
          { candle: 3, side: 'SELL', symbols: ['ETH/USDT'] },
          { candle: 5, side: 'SELL', symbols: ['BTC/USDT'] },
        ],
      }),
      {
        'BTC/USDT': candlesClosingAt({ 5: 9500, 8: 9800 }),
        'ETH/USDT': candlesClosingAt({ 2: 2100, 3: 2200 }, { open: 2000, spread: 10, volume: 100 }),
      },
    );

    // DebugPositionBook plays each step on its pair through the book, as the signal strategies trade: the ETH BUY of 00:01 takes 50 % of
    // the currency, BTC flat beside it, the BTC BUY of 00:02 goes all-in, ETH long by then, and each SELL sells all of its asset. Each
    // MARKET order fills at the close of its candle, dated at its end, for a fee of 0.1 %, and is heard with the bucket it fills in.
    expect({ failure, orderCalls, report: loggedReport('TRADING REPORT'), roundTrips: loggedRoundTrips() }).toEqual({
      failure: undefined,
      orderCalls: [
        // 50 % of the 400000 USDT read, of which 95 % at 2000: 190000 / 2000. It costs 95 × 2000 × 1.001 = 190190: 209810 USDT are left.
        filledMarketOrder(minute(2), 'ETH/USDT', 'BUY', 95, 1),
        // The 209810 USDT read after the ETH fill, of which 95 % at 10000: 199319.5 / 10000. It costs 199319.5 × 1.001 = 199518.8195:
        // 10291.1805 USDT are left.
        filledMarketOrder(minute(3), 'BTC/USDT', 'BUY', 19.93195, 2),
        // All of each asset. The ETH SELL brings in 95 × 2200 × 0.999 = 208791 (219082.1805 USDT), the BTC SELL 19.93195 × 9500 × 0.999
        // = 189164.171475 (408246.351975 USDT).
        filledMarketOrder(minute(4), 'ETH/USDT', 'SELL', 95, 3),
        filledMarketOrder(minute(6), 'BTC/USDT', 'SELL', 19.93195, 4),
      ],
      report: {
        id: 'TRADING REPORT',
        // From the close of the candle that completed the warmup, 00:00's, to that of the last candle read, 00:08's
        periodStartAt: minute(1),
        periodEndAt: minute(9),
        formattedDuration: '8 minutes',
        // The P&L of the two round trips, 18601 - 10354.648025: the 408246.351975 USDT held at the end less the 400000 of the start
        netProfit: 8246.351975,
        // Over a day, the horizon of a period shorter than one, 1/366 of the year 2024: 8246.351975 × 366
        annualizedNetProfit: 3018164.82285,
        // 8246.351975 / 400000 × 100
        totalReturnPct: 2.06158799375,
        // 2.06158799375 × 366
        annualizedReturnPct: 754.5412057125,
        // The benchmark, BTC, watched: from its close of 00:00, 10000, to that of 00:08, 9800
        marketReturnPct: -2,
        // 2.06158799375 - (-2)
        alpha: 4.06158799375,
        // In a round trip from 00:02, the ETH BUY's fill, to 00:06, the BTC SELL's: 4 of the 8 minutes. Added up, the two round trips
        // would count 00:03 to 00:04 twice: 5 minutes, 62.5 %.
        exposurePct: 50,
        // The population standard deviation of the two profits, half their difference: (4.65025 + 2.529781345435) / 2
        volatility: 3.5900156727174997,
        // The root mean square of the one loss over both profits: 2.529781345435 / √2
        downsideDeviation: 1.7888255442763163,
        // (annualizedReturnPct - 5, the risk-free return) / (the deviation × √(2 returns × 366 a year)): 749.5412057125 over
        // 3.5900156727174997 × √732, then over 1.7888255442763163 × √732
        sharpeRatio: 7.716913423670418,
        sortinoRatio: 15.487167110635523,
        startPrice: 10000,
        endPrice: 9800,
        benchmarkAsset: 'BTC',
        // The value of the whole portfolio, each asset at its close: USDT alone at both ends
        startBalance: 400000,
        finalBalance: 408246.351975,
        // ETH's round trip won, BTC's lost
        winRate: 50,
        topMAEs: [6, 0],
        tradeCount: 4,
        // One entry per pair, in the order of watch.assets, whatever the order of their round trips: BTC in a round trip from 00:03 to
        // 00:06, 3 of the 8 minutes, ETH from 00:02 to 00:04, 2 of them
        pairs: [
          {
            symbol: 'BTC/USDT',
            roundTripCount: 1,
            winCount: 0,
            winRate: 0,
            tradeCount: 2,
            pnl: -10354.648025,
            exposurePct: 37.5,
            maxAdverseExcursion: 6,
          },
          {
            symbol: 'ETH/USDT',
            roundTripCount: 1,
            winCount: 1,
            winRate: 100,
            tradeCount: 2,
            pnl: 18601,
            exposurePct: 25,
            maxAdverseExcursion: 0,
          },
        ],
      },
      roundTrips: [
        // ETH's, closed first: numbered 0, though BTC comes first in watch.assets. 95 bought at 2000, 190000, and sold at 2200, 209000,
        // less the fees, 190 and 209: 18601, 4.65025 % of the 400000 the portfolio was worth before the BUY, the 209810 USDT left after
        // it, 95 ETH at its price and its fee. The lows it reads, of the candles closing after its BUY, 00:02 and 00:03, never fall below
        // 2000.
        {
          id: 0,
          symbol: 'ETH/USDT',
          entryAt: minute(2),
          entryPrice: 2000,
          entryEquity: 400000,
          exitAt: minute(4),
          exitPrice: 2200,
          cost: 190000,
          proceeds: 209000,
          fees: 399,
          pnl: 18601,
          profit: 4.65025,
          maxAdverseExcursion: 0,
          duration: 2 * ONE_MINUTE,
        },
        // 19.93195 BTC bought at 10000, 199319.5, and sold at 9500, 189353.525, less the fees 199.3195 and 189.353525: -10354.648025,
        // from its own fills alone, the 208791 USDT the ETH SELL brought in while BTC was held left out. -10354.648025 / 409310 × 100, of
        // the 409310 the portfolio was worth before the BUY, ETH at its last close, 2100: the 10291.1805 USDT left after it, 19.93195 BTC
        // at its price, 199319.5, 95 ETH at 2100, 199500, and its fee. Its adverse excursion is the low of 00:05, 9400: (10000 - 9400) /
        // 10000 × 100.
        {
          id: 1,
          symbol: 'BTC/USDT',
          entryAt: minute(3),
          entryPrice: 10000,
          entryEquity: 409310,
          exitAt: minute(6),
          exitPrice: 9500,
          cost: 199319.5,
          proceeds: 189353.525,
          fees: 388.673025,
          pnl: -10354.648025,
          profit: -2.529781345435,
          maxAdverseExcursion: 6,
          duration: 3 * ONE_MINUTE,
        },
      ],
    });
  });
});
