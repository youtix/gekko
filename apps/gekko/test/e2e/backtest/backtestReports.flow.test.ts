import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { range } from 'lodash-es';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rawDaterange, type RawConfiguration } from '../helpers/configuration.helper';
import { clearLogs, findTextLines, loggedReport } from '../mocks/winston.mock';
import { candlesClosingAt, minute, mockBacktestModules, rawMarket, refusedMarketOrder, runBacktest } from './backtestRun.helper';

mockBacktestModules();

/** The header of the PerformanceReporter's file, one column per figure of either report: a report leaves empty those it has not */
const CSV_HEADER = [
  'id',
  'report type',
  'pair',
  'timeframe',
  'net profit',
  'total return',
  'yearly profit',
  'win rate',
  'market',
  'alpha',
  'sharpe ratio',
  'sortino ratio',
  'max drawdown',
  'total changes',
  'trade count',
  'start time',
  'end time',
  'duration',
  'exposure',
  'start balance',
  'final balance',
  'start price',
  'end price',
  'standard deviation',
  'downside deviation',
  'longest drawdown duration',
  'benchmark asset',
  'top maes',
  'status',
].join(';');

/** The reason the circuit breaker stops a run with, after the fifth order in a row that ended in error, the default of the TradingAdvisor */
const BREAKER_STOP = '[STRATEGY] Max consecutive order errors reached (5)';

let directory: string;

/**
 * A backtest of BTC, or of each of `assets`, against USDT, on 1m candles, of the minutes 00:00 to 00:08, from an account holding `usdt`,
 * reported by `analyzer` and written by the PerformanceReporter to `file`, in the temporary directory of the suite: DebugBacktest trades
 * 1 unit of every pair on its calendar
 */
const backtestOf = (
  usdt: number,
  analyzer: { name: 'RoundTripAnalyzer' | 'PortfolioAnalyzer'; enableConsoleTable?: boolean },
  calendar: { buyCandleIndex: number | number[]; sellCandleIndex: number | number[] },
  file: string,
  assets: ('BTC' | 'ETH')[] = ['BTC'],
): RawConfiguration => ({
  watch: {
    mode: 'backtest',
    assets,
    currency: 'USDT',
    timeframe: '1m',
    daterange: rawDaterange({ start: minute(0), end: minute(9) - 1 }),
  },
  exchange: {
    name: 'dummy-cex',
    simulationBalance: [...assets.map(assetName => ({ assetName, balance: 0 })), { assetName: 'USDT', balance: usdt }],
    marketData: assets.map(asset => rawMarket(`${asset}/USDT`)),
  },
  storage: { type: 'sqlite', database: ':memory:' },
  plugins: [
    { name: 'TradingAdvisor', strategyName: 'DebugBacktest' },
    { name: 'Trader' },
    analyzer,
    { name: 'PerformanceReporter', filePath: directory, fileName: file },
  ],
  strategy: { name: 'DebugBacktest', ...calendar },
});

/** The lines of a file the PerformanceReporter wrote, its header first */
const readRows = (file: string) => readFileSync(join(directory, file), 'utf8').split('\n');

describe('E2E: Backtest reports', () => {
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'gekko-reports-e2e-'));
  });

  beforeEach(() => {
    clearLogs();
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('writes the report of a run that reached the end of its range under the header of the file, its status completed', async () => {
    const { failure } = await runBacktest(
      backtestOf(300000, { name: 'RoundTripAnalyzer' }, { buyCandleIndex: 1, sellCandleIndex: 3 }, 'completed.csv'),
      { 'BTC/USDT': candlesClosingAt({ 1: 9000, 3: 11000 }) },
    );

    // A BUY of 1 at the close of 00:01, 9000, and a SELL of 1 at that of 00:03, 11000, for a fee of 0.1 % each: 10989 - 9009 = 1980 of
    // profit, 0.66 % of 300000, annualized over a day, 1/366 of the year 2024. The period runs from the close of the candle that completed
    // the warmup, 00:00, to that of the last one read, 00:08: the round trip is open from the BUY's fill, at 00:02, to the SELL's, at
    // 00:04, 2 of its 8 minutes. One round trip deviates from nothing: no ratio, no deviation. Its lows, of the candles closing after the
    // BUY filled, never fall below 9000.
    expect({ failure, rows: readRows('completed.csv') }).toEqual({
      failure: undefined,
      rows: [
        CSV_HEADER,
        // The id of the run, its strategy block's values; the columns of the PortfolioAnalyzer left empty, but the benchmark asset, which
        // the market return is measured on: BTC, watched
        'DebugBacktest-1-3;Trading;BTC/USDT;1m;1980;0.66%;724680 (241.56%);100%;0%;0.66%;0.00;0.00;;;2;2024-01-01T00:01:00.000Z;2024-01-01T00:09:00.000Z;8 minutes;25%;300000;301980;10000;10000;0.00;0.00;;BTC;[0];completed',
        '',
      ],
    });
  });

  it('stops on the circuit breaker once five orders in a row are refused, the report covering the period up to the stop and saying why', async () => {
    // 1000 USDT, and a BUY of 1 BTC at 10000 on each of the candles 00:00 to 00:06: every one is refused for want of currency
    const { failure, orderCalls } = await runBacktest(
      backtestOf(1000, { name: 'PortfolioAnalyzer' }, { buyCandleIndex: range(7), sellCandleIndex: [] }, 'stopped.csv'),
      { 'BTC/USDT': candlesClosingAt() },
    );

    // The fifth refusal, that of the BUY of 00:04, reaches the strategy with the bucket of 00:04: the breaker stops the run there, its
    // plugins finalised with the stop, which the analyzer reports as the interruption of its period, which the file writes as its status
    const refusal = 'InvalidOrder: [EXCHANGE] Insufficient currency balance (portfolio: 1000, order cost: 10010)';
    expect({
      failure: failure && { name: failure.name, message: failure.message },
      orderCalls,
      stopLine: findTextLines('Application stopped', 'warn').map(({ message }) => message),
      report: loggedReport('PORTFOLIO PROFIT REPORT'),
      rows: readRows('stopped.csv'),
    }).toEqual({
      failure: { name: 'ApplicationStopError', message: BREAKER_STOP },
      // 10000 × 1.001 = 10010 to pay, each order dated at the end of the minute it goes out with
      orderCalls: range(5).map(n => refusedMarketOrder(minute(n + 1), 'BTC/USDT', 'BUY', 1, refusal)),
      stopLine: [`Application stopped gracefully: ${BREAKER_STOP}`],
      report: {
        id: 'PORTFOLIO PROFIT REPORT',
        // From the close of the candle that completed the warmup, 00:00, to that of the last one processed, 00:04
        periodStartAt: minute(1),
        periodEndAt: minute(5),
        formattedDuration: '4 minutes',
        // Nothing bought: 1000 USDT from start to end, BTC at 10000
        netProfit: 0,
        annualizedNetProfit: 0,
        totalReturnPct: 0,
        annualizedReturnPct: 0,
        marketReturnPct: 0,
        alpha: 0,
        exposurePct: 0,
        volatility: 0,
        downsideDeviation: 0,
        // (0 - 5, the risk-free return) over a deviation of 0: no ratio
        sharpeRatio: 0,
        sortinoRatio: 0,
        startPrice: 10000,
        endPrice: 10000,
        maxDrawdownPct: 0,
        longestDrawdownMs: 0,
        startEquity: 1000,
        endEquity: 1000,
        // Delivered once for the synchronizations of the start-up and of the end of the warmup, then once after each refusal
        portfolioChangeCount: 6,
        benchmarkAsset: 'BTC',
        // A point at the close of each candle processed, 00:00 to 00:04
        equityCurveLength: 5,
        interruption: BREAKER_STOP,
      },
      rows: [
        CSV_HEADER,
        // The columns of the RoundTripAnalyzer left empty; no drawdown, written 0
        `DebugBacktest-0-1-2-3-4-5-6;Portfolio;BTC/USDT;1m;0;0%;0 (0%);;0%;0%;0.00;0.00;0%;6;;2024-01-01T00:01:00.000Z;2024-01-01T00:05:00.000Z;4 minutes;0%;1000;1000;10000;10000;0.00;0.00;0;BTC;;interrupted: ${BREAKER_STOP}`,
        '',
      ],
    });
  });

  describe('with the console table', () => {
    let printed: unknown[][];
    let spies: { mockRestore: () => void }[];

    // What the tables print, on stdout whatever GEKKO_LOG_LEVEL, kept off the output of the test
    beforeEach(() => {
      printed = [];
      spies = [
        spyOn(console, 'log').mockImplementation((...args: unknown[]) => printed.push(['log', ...args])),
        spyOn(console, 'table').mockImplementation((...args: unknown[]) => printed.push(['table', ...args])),
      ];
    });

    afterEach(() => {
      for (const spy of spies) spy.mockRestore();
    });

    it('prints the reason a run stopped above the table of its report, and writes it as the status of its row', async () => {
      const { failure } = await runBacktest(
        backtestOf(
          1000,
          { name: 'RoundTripAnalyzer', enableConsoleTable: true },
          { buyCandleIndex: range(7), sellCandleIndex: [] },
          'table.csv',
        ),
        { 'BTC/USDT': candlesClosingAt() },
      );

      expect({ failure: failure?.message, printed, rows: readRows('table.csv') }).toEqual({
        failure: BREAKER_STOP,
        printed: [
          ['log', `Run interrupted, the report below covers a partial period. Reason: ${BREAKER_STOP}`],
          [
            'table',
            {
              label: 'PROFIT REPORT',
              periodStartAt: '2024-01-01T00:01:00.000Z',
              periodEndAt: '2024-01-01T00:05:00.000Z',
              duration: '4 minutes',
              exposurePct: '0% of time exposed',
              startPrice: '10,000 USDT',
              endPrice: '10,000 USDT',
              // The asset of those prices, the one the market return is measured on: BTC, watched, on one pair too
              benchmark: 'BTC',
              netProfit: '0 USDT',
              totalReturnPct: '0%',
              marketReturnPct: '0%',
              alpha: '0%',
              annualizedNetProfit: '0 USDT (0%)',
              // No round trip: no trade, no win rate, no MAE
              tradeCount: 0,
              startBalance: '1,000 USDT',
              finalBalance: '1,000 USDT',
              sharpeRatio: '0.00',
              sortinoRatio: '0.00',
              volatility: '0.00',
              downsideDeviation: '0.00',
              winRate: 'N/A',
              topMAEs: '',
            },
          ],
        ],
        rows: [
          CSV_HEADER,
          `DebugBacktest-0-1-2-3-4-5-6;Trading;BTC/USDT;1m;0;0%;0 (0%);N/A;0%;0%;0.00;0.00;;;0;2024-01-01T00:01:00.000Z;2024-01-01T00:05:00.000Z;4 minutes;0%;1000;1000;10000;10000;0.00;0.00;;BTC;[];interrupted: ${BREAKER_STOP}`,
          '',
        ],
      });
    });

    it('prints a table per round trip naming its pair, the table of the report, then a table of the pairs, when several are watched', async () => {
      // A BUY of 1 BTC and of 1 ETH with the candle of 00:01, a SELL of each with that of 00:03: BTC closes at 9000, then 11000, its
      // high and low 100 off; ETH at 2200, then 1800, 10 off. Both open every minute at their usual price, 10000 and 2000.
      const { failure } = await runBacktest(
        backtestOf(
          300000,
          { name: 'RoundTripAnalyzer', enableConsoleTable: true },
          { buyCandleIndex: 1, sellCandleIndex: 3 },
          'pairs.csv',
          ['BTC', 'ETH'],
        ),
        {
          'BTC/USDT': candlesClosingAt({ 1: 9000, 3: 11000 }),
          'ETH/USDT': candlesClosingAt({ 1: 2200, 3: 1800 }, { open: 2000, spread: 10, volume: 100 }),
        },
      );

      // Each order fills at the close of its candle, dated at its end, for a fee of 0.1 %: the BUYs cost 9009 and 2202.2, the SELLs
      // bring in 10989 and 1798.2, and the account ends with 301576 USDT. Each round trip is printed as it closes, BTC's first, its SELL
      // sent first, both from 00:02 to 00:04.
      expect({ failure, printed, rows: readRows('pairs.csv') }).toEqual({
        failure: undefined,
        printed: [
          // 11000 - 9000, less the fees 9 and 11: 1980, 0.66 % of the 299997.8 the portfolio was worth before its BUY, as the balance
          // read after both BUYs shows it, the 2.2 of the ETH BUY's fee paid. The lows of 00:02 and 00:03 never fall below 9000.
          [
            'table',
            {
              pair: 'BTC/USDT',
              entryDateUTC: '2024-01-01T00:02:00.000Z',
              exitDateUTC: '2024-01-01T00:04:00.000Z',
              exposedDuration: '2 minutes',
              'P&L': '1,980 USDT',
              profit: '0.66%',
              MAE: '0%',
            },
          ],
          // 1800 - 2200, less the fees 2.2 and 1.8: -404, -0.1346… % of 299991, the 9 of the BTC BUY's fee paid, rounded down. The low
          // of 00:03, 1790, is 410 below its entry: 410 / 2200 × 100, 18.6363… %.
          [
            'table',
            {
              pair: 'ETH/USDT',
              entryDateUTC: '2024-01-01T00:02:00.000Z',
              exitDateUTC: '2024-01-01T00:04:00.000Z',
              exposedDuration: '2 minutes',
              'P&L': '-404 USDT',
              profit: '-0.14%',
              MAE: '18.63%',
            },
          ],
          [
            'table',
            {
              label: 'PROFIT REPORT',
              periodStartAt: '2024-01-01T00:01:00.000Z',
              periodEndAt: '2024-01-01T00:09:00.000Z',
              duration: '8 minutes',
              // Both round trips run from 00:02 to 00:04: 2 of the 8 minutes, counted once
              exposurePct: '25% of time exposed',
              // The benchmark, BTC, watched, closes 00:00 and 00:08 at 10000: the table names it, its prices being those of one pair
              startPrice: '10,000 USDT',
              endPrice: '10,000 USDT',
              benchmark: 'BTC',
              // 1980 - 404, 0.525333… % of 300000
              netProfit: '1,576 USDT',
              totalReturnPct: '0.52%',
              marketReturnPct: '0%',
              alpha: '0.52%',
              // Over a day of 2024: 1576 × 366, 0.525333… % × 366
              annualizedNetProfit: '576,816 USDT (192.27%)',
              tradeCount: 4,
              startBalance: '300,000 USDT',
              finalBalance: '301,576 USDT',
              // 187.272, the annualized return less the risk-free 5, over each deviation × √(2 returns × 366 a year): the volatility half
              // the difference of the two profits, (0.66 + 0.1347) / 2, the downside deviation the loss over √2
              sharpeRatio: '17.42',
              sortinoRatio: '72.69',
              volatility: '0.40',
              downsideDeviation: '0.10',
              winRate: '50%',
              topMAEs: '18.63%, 0%',
            },
          ],
          // Each pair, in the order of watch.assets
          [
            'table',
            {
              'BTC/USDT': {
                roundTrips: 1,
                wins: 1,
                winRate: '100%',
                tradeCount: 2,
                'P&L': '1,980 USDT',
                exposurePct: '25%',
                deepestMAE: '0%',
              },
              'ETH/USDT': {
                roundTrips: 1,
                wins: 0,
                winRate: '0%',
                tradeCount: 2,
                'P&L': '-404 USDT',
                exposurePct: '25%',
                deepestMAE: '18.63%',
              },
            },
          ],
        ],
        rows: [
          CSV_HEADER,
          // One row for the run, its pairs in one cell, the MAEs written as amounts are, to 8 decimals
          'DebugBacktest-1-3;Trading;BTC/USDT ETH/USDT;1m;1576;0.52%;576816 (192.27%);50%;0%;0.52%;17.42;72.69;;;4;2024-01-01T00:01:00.000Z;2024-01-01T00:09:00.000Z;8 minutes;25%;300000;301576;10000;10000;0.40;0.10;;BTC;[18.63636364,0];completed',
          '',
        ],
      });
    });
  });
});
