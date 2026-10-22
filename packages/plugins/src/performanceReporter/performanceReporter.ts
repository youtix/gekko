import { describeError } from '@gekko/shared/errors/error.helper';
import { PERCENT_ROUNDING } from '../analyzers/analyzer.const';
import { Plugin } from '@gekko/core/plugin/plugin';
import { lockSync as defaultLockSync } from '@gekko/core/fs/fs.service';
import { Fs } from '@gekko/shared/models/fs.types';
import { error } from '@gekko/core/logger/logger';
import { formatDurationUTC, toISOString } from '@gekko/shared/utils/date/date.utils';
import { formatPercent, formatRatio, toPlainNumber } from '@gekko/shared/utils/string/string.utils';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'fs';
import { random } from 'lodash-es';
import path from 'path';
import { BYTE_ORDER_MARK, REPORT_TYPES } from './performanceReporter.const';
import { generateStrategyId, portfolioOnly, toCsvCell, tradingOnly } from './performanceReporter.helper';
import { performanceReporterSchema } from '@gekko/schemas/plugins/performanceReporter.schema';
import { CsvColumn, PerformanceReport, PerformanceReporterConfig } from './performanceReporter.types';

export class PerformanceReporter extends Plugin {
  private readonly filePath: string;
  private fs: Fs = { lockSync: defaultLockSync };

  // Both analyzers write to the same file by default, so both report types share one header, and the header and the rows
  // are built from this one list: a metric that a report type does not have leaves its column empty.
  private readonly columns: CsvColumn[] = [
    { header: 'id', value: () => generateStrategyId(this.strategySettings) },
    { header: 'report type', value: report => REPORT_TYPES[report.id] },
    // Without the pair and the timeframe, runs of the same strategy on other pairs or timeframes could not be told apart.
    // A run can watch several pairs, under either analyzer: they share the cell, separated by a space as ';' separates the columns.
    { header: 'pair', value: () => this.pairs.join(' ') },
    // The schema only leaves the timeframe out in importer mode, which this plugin does not run in.
    { header: 'timeframe', value: () => this.timeframe ?? '' },
    // The amounts and the prices are written for a program to read, the same whatever the locale of the machine (see toPlainNumber).
    { header: 'net profit', value: report => toPlainNumber(report.netProfit) },
    // Each percentage rounded as its figure is wherever it is written (see PERCENT_ROUNDING)
    { header: 'total return', value: report => formatPercent(report.totalReturnPct, PERCENT_ROUNDING.totalReturnPct) },
    {
      header: 'yearly profit',
      value: report =>
        `${toPlainNumber(report.annualizedNetProfit)} (${formatPercent(report.annualizedReturnPct, PERCENT_ROUNDING.annualizedReturnPct)})`,
    },
    {
      header: 'win rate',
      value: tradingOnly(({ winRate }) => (winRate !== null ? formatPercent(winRate, PERCENT_ROUNDING.winRate) : 'N/A')),
    },
    { header: 'market', value: report => formatPercent(report.marketReturnPct, PERCENT_ROUNDING.marketReturnPct) },
    { header: 'alpha', value: report => formatPercent(report.alpha, PERCENT_ROUNDING.alpha) },
    { header: 'sharpe ratio', value: report => formatRatio(report.sharpeRatio) },
    { header: 'sortino ratio', value: report => formatRatio(report.sortinoRatio) },
    {
      header: 'max drawdown',
      value: portfolioOnly(({ maxDrawdownPct }) => formatPercent(maxDrawdownPct, PERCENT_ROUNDING.maxDrawdownPct)),
    },
    { header: 'total changes', value: portfolioOnly(({ portfolioChangeCount }) => portfolioChangeCount) },
    { header: 'trade count', value: tradingOnly(({ tradeCount }) => tradeCount) },
    { header: 'start time', value: report => toISOString(report.periodStartAt) },
    { header: 'end time', value: report => toISOString(report.periodEndAt) },
    { header: 'duration', value: report => report.formattedDuration },
    { header: 'exposure', value: report => formatPercent(report.exposurePct, PERCENT_ROUNDING.exposurePct) },
    {
      header: 'start balance',
      value: report => toPlainNumber(report.id === 'PORTFOLIO PROFIT REPORT' ? report.startEquity : report.startBalance),
    },
    {
      header: 'final balance',
      value: report => toPlainNumber(report.id === 'PORTFOLIO PROFIT REPORT' ? report.endEquity : report.finalBalance),
    },
    { header: 'start price', value: report => toPlainNumber(report.startPrice) },
    { header: 'end price', value: report => toPlainNumber(report.endPrice) },
    { header: 'standard deviation', value: report => formatRatio(report.volatility) },
    { header: 'downside deviation', value: report => formatRatio(report.downsideDeviation) },
    {
      header: 'longest drawdown duration',
      // From the epoch on the UTC calendar, the same on every machine: on a machine whose zone had daylight saving time in 1970 (New
      // York), 120 days read "3 months 30 days 1 hour" (see formatDurationUTC)
      value: portfolioOnly(({ longestDrawdownMs }) => (longestDrawdownMs > 0 ? formatDurationUTC(0, longestDrawdownMs) : '0')),
    },
    // Both reports name the asset they measure the market against (see Report.benchmarkAsset): the cell of a trading row was left empty,
    // though the RoundTripAnalyzer measured it against its pair. The header is unchanged, so a file written before still takes the rows.
    { header: 'benchmark asset', value: report => report.benchmarkAsset },
    // A JSON array of numbers written as the amounts are (see toPlainNumber): JSON.stringify wrote every digit of the binary value,
    // 33.33333333333333, and an exponent below 1e-6, 1.000000338535756e-8
    { header: 'top maes', value: tradingOnly(({ topMAEs }) => `[${topMAEs.map(toPlainNumber).join(',')}]`) },
    // The row of a run stopped before its end (a crash, missing candles, the circuit breaker) says why, rather than passing for that of
    // a full run. The reason is written as the error gave it, quoted when it holds the separator or a line break (see toCsvCell).
    { header: 'status', value: ({ interruption }) => (interruption === undefined ? 'completed' : `interrupted: ${interruption}`) },
  ];

  private readonly header = this.columns.map(({ header }) => header).join(';');

  constructor({ name, filePath, fileName }: PerformanceReporterConfig) {
    super(name);
    this.filePath = path.join(filePath, fileName);
  }

  public setFs(fs: Fs) {
    this.fs = fs;
  }

  // Here the payload is not an array because onPerformanceReport use emit function directly.
  // It is not using the sequentialEmitter because it is emitted in processFinalize() of plugin lifecycle hooks
  public onPerformanceReport(report: PerformanceReport) {
    if (!Object.hasOwn(REPORT_TYPES, report.id)) return;

    const row = `${this.columns.map(({ value }) => toCsvCell(value(report))).join(';')}\n`;
    let release: () => void;
    try {
      // The backtests of a parameter sweep can end together and write the same file: one lock covers writing the header,
      // checking it and appending the row, so that no other run writes in between. The delay between attempts is random: with
      // the same delay, the runs that miss the lock together would retry together, and only a few would get it each time.
      release = this.fs.lockSync(this.filePath, { retries: 5, retryDelayMs: random(25, 75) });
    } catch (err) {
      // Not thrown: an exception in a plugin ends the run with exit code 1. The failure is described, not interpolated, here as in
      // the two catches below: a template literal calls String(), which throws for a value without a prototype, from the catch itself.
      error('performance reporter', `report lost: ${report.id} not written, ${this.filePath} could not be locked (${describeError(err)})`);
      return;
    }
    try {
      if (this.isMissingOrEmpty()) writeFileSync(this.filePath, `${this.header}\n`, 'utf8');
      if (this.startsWithHeader()) {
        appendFileSync(this.filePath, row, 'utf8');
      } else {
        // A row appended under another header would sit under columns that mean something else.
        error(
          'performance reporter',
          `report not written: the first line of ${this.filePath} is not the expected header (another column layout or an older version of this plugin): move or rename it`,
        );
      }
    } catch (err) {
      error('performance reporter', `write error: ${describeError(err)}`);
    } finally {
      release();
    }
  }

  private isMissingOrEmpty() {
    return !existsSync(this.filePath) || statSync(this.filePath).size === 0;
  }

  /**
   * Reads only the length of the header line: the file gains a row with every run. A spreadsheet that saves the file back
   * (Excel or LibreOffice on Windows) can start it with a byte order mark and end its lines with '\r\n': the header is the
   * same, so it is accepted. A header without its line break is not, as the row appended to it would continue that line.
   */
  private startsWithHeader() {
    const firstBytes = Buffer.alloc(Buffer.byteLength(`${BYTE_ORDER_MARK}${this.header}\r\n`));
    const fd = openSync(this.filePath, 'r');
    let length: number;
    try {
      length = readSync(fd, firstBytes, 0, firstBytes.length, 0);
    } finally {
      closeSync(fd);
    }
    const start = firstBytes.toString('utf8', 0, length).replace(/^\uFEFF/, '');
    return start.startsWith(`${this.header}\n`) || start.startsWith(`${this.header}\r\n`);
  }

  // --------------------------------------------------------------------------
  //                           PLUGIN LIFECYCLE HOOKS
  // --------------------------------------------------------------------------

  protected processInit(): void {
    try {
      // Create parent folders if the user supplied a nested path
      mkdirSync(path.dirname(this.filePath), { recursive: true });
    } catch (err) {
      error('performance reporter', `setup error: ${describeError(err)}`);
    }
  }

  protected processOneMinuteBucket(): void {
    /* noop */
  }
  protected processFinalize(): void {
    /* noop */
  }

  public static getStaticConfiguration() {
    return {
      name: 'PerformanceReporter',
      schema: performanceReporterSchema,
      modes: ['backtest'],
      dependencies: [],
      inject: [],
      eventsHandlers: [...Object.getOwnPropertyNames(PerformanceReporter.prototype).filter(n => n.startsWith('on'))],
      eventsEmitted: [],
    } as const;
  }
}
