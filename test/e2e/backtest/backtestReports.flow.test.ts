import type { Candle } from '@models/candle.types';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { range } from 'lodash-es';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rawDaterange, type RawConfiguration } from '../helpers/configuration.helper';
import { clearLogs, findLoggedObject, findTextLines } from '../mocks/winston.mock';
import { minute, mockBacktestModules, rawMarket, refusedMarketOrder, runBacktest } from './backtestRun.helper';

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
 * A backtest of BTC on 1m candles, of the minutes 00:00 to 00:08, from an account holding `usdt`, reported by `analyzer` and written
 * by the PerformanceReporter to `file`, in the temporary directory of the suite
 */
const backtestOf = (
  usdt: number,
  analyzer: { name: 'RoundTripAnalyzer' | 'PortfolioAnalyzer'; enableConsoleTable?: boolean },
  calendar: { buyCandleIndex: number | number[]; sellCandleIndex: number | number[] },
  file: string,
): RawConfiguration => ({
  watch: {
    mode: 'backtest',
    assets: ['BTC'],
    currency: 'USDT',
    timeframe: '1m',
    daterange: rawDaterange({ start: minute(0), end: minute(9) - 1 }),
  },
  exchange: {
    name: 'dummy-cex',
    simulationBalance: [
      { assetName: 'BTC', balance: 0 },
      { assetName: 'USDT', balance: usdt },
    ],
    marketData: [rawMarket('BTC/USDT')],
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

/** BTC opening every minute at 10000 and closing there, but at the prices `closes` lists, its high and low 100 off its close */
const candlesOf = (closes: Record<number, number> = {}): Candle[] =>
  range(9).map(n => {
    const close = closes[n] ?? 10000;
    return { start: minute(n), open: 10000, high: close + 100, low: close - 100, close, volume: 10 };
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
      { 'BTC/USDT': candlesOf({ 1: 9000, 3: 11000 }) },
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
        // The id of the run, its strategy block's values; the columns of the PortfolioAnalyzer left empty
        'DebugBacktest-1-3;Trading;BTC/USDT;1m;1980;0.66%;724680 (241.56%);100%;0%;0.66%;0.00;0.00;;;2;2024-01-01T00:01:00.000Z;2024-01-01T00:09:00.000Z;8 minutes;25%;300000;301980;10000;10000;0.00;0.00;;;[0];completed',
        '',
      ],
    });
  });

  it('stops on the circuit breaker once five orders in a row are refused, the report covering the period up to the stop and saying why', async () => {
    // 1000 USDT, and a BUY of 1 BTC at 10000 on each of the candles 00:00 to 00:06: every one is refused for want of currency
    const { failure, orderCalls } = await runBacktest(
      backtestOf(1000, { name: 'PortfolioAnalyzer' }, { buyCandleIndex: range(7), sellCandleIndex: [] }, 'stopped.csv'),
      { 'BTC/USDT': candlesOf() },
    );

    // The fifth refusal, that of the BUY of 00:04, reaches the strategy with the bucket of 00:04: the breaker stops the run there, its
    // plugins finalised with the stop, which the analyzer reports as the interruption of its period, which the file writes as its status
    const refusal = 'InvalidOrder: [EXCHANGE] Insufficient currency balance (portfolio: 1000, order cost: 10010)';
    expect({
      failure: failure && { name: failure.name, message: failure.message },
      orderCalls,
      stopLine: findTextLines('Application stopped', 'warn').map(({ message }) => message),
      report: findLoggedObject(({ id }) => id === 'PORTFOLIO PROFIT REPORT'),
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
        { 'BTC/USDT': candlesOf() },
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
          `DebugBacktest-0-1-2-3-4-5-6;Trading;BTC/USDT;1m;0;0%;0 (0%);N/A;0%;0%;0.00;0.00;;;0;2024-01-01T00:01:00.000Z;2024-01-01T00:05:00.000Z;4 minutes;0%;1000;1000;10000;10000;0.00;0.00;;;[];interrupted: ${BREAKER_STOP}`,
          '',
        ],
      });
    });
  });
});
