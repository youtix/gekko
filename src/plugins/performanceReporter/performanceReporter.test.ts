import { GekkoError } from '@errors/gekko.error';
import { Watch } from '@models/configuration.types';
import { PortfolioReport } from '@plugins/analyzers/portfolioAnalyzer/portfolioAnalyzer.types';
import { TradingReport } from '@plugins/analyzers/roundTripAnalyzer/roundTrip.types';
import { config } from '@services/configuration/configuration';
import { useTimeZone } from '@utils/date/date.mock';
import * as fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { PerformanceReporter } from './performanceReporter';

vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
  openSync: vi.fn(),
  readSync: vi.fn(),
  closeSync: vi.fn(),
}));

vi.mock('@services/logger', () => ({
  error: vi.fn(),
}));

// A backtest on one pair, as config.getWatch() returns it: the timeframe belongs to the watch, not to a pair.
const WATCH = vi.hoisted<Watch>(() => ({
  mode: 'backtest',
  assets: ['BTC'],
  currency: 'USDT',
  pairs: [{ symbol: 'BTC/USDT' }],
  timeframe: '1h',
  tickrate: 1000,
  warmup: { tickrate: 1000, candleCount: 0 },
}));

vi.mock('@services/configuration/configuration', () => ({
  config: {
    getWatch: vi.fn(() => WATCH),
    getStrategy: vi.fn(() => ({ name: 'DEMA' })),
  },
}));

const HEADER =
  'id;report type;pair;timeframe;net profit;total return;yearly profit;win rate;market;alpha;sharpe ratio;sortino ratio;max drawdown;total changes;trade count;start time;end time;duration;exposure;start balance;final balance;start price;end price;standard deviation;downside deviation;longest drawdown duration;benchmark asset;top maes;status';

const HEADER_COLUMN_COUNT = HEADER.split(';').length;

// The headers of the versions that had one column layout per report type, the last of which added a status column to both.
const OLD_PORTFOLIO_HEADER =
  'id;pair;net profit;total return;yearly profit;market;alpha;sharpe ratio;sortino ratio;max drawdown;total changes;start time;end time;duration;exposure;original balance;current balance;start price;end price;standard deviation;downside deviation;longest drawdown duration;benchmark asset';

const OLD_TRADING_HEADER =
  'id;pair;net profit;total return;annualized return;win rate;market;alpha;sharpe ratio;sortino ratio;trade count;start time;end time;duration;exposure;start balance;final balance;start price;end price;standard deviation;downside deviation;top maes';

const DAY = 86_400_000;

const baseConfig = {
  name: 'PerformanceReporter',
  filePath: '/tmp',
  fileName: 'performanceReporter.csv',
};

const expectedPath = path.join(baseConfig.filePath, baseConfig.fileName);

const commonReportProps = {
  periodStartAt: 1748563200000,
  periodEndAt: 1748649600000,
  formattedDuration: '1 day',
  exposurePct: 0.5,
  marketReturnPct: 0.01,
  alpha: 0.12,
  annualizedNetProfit: 3650,
  annualizedReturnPct: 116.8,
  sharpeRatio: 1.25,
  sortinoRatio: 1.1,
  volatility: 2.5,
  startPrice: 100,
  endPrice: 110,
  netProfit: 100,
  totalReturnPct: 10,
  downsideDeviation: 0.5,
};

const samplePortfolioReport: PortfolioReport = {
  ...commonReportProps,
  id: 'PORTFOLIO PROFIT REPORT',
  equityCurve: [],
  maxDrawdownPct: 0.08,
  longestDrawdownMs: 9000000,
  startEquity: 1000,
  endEquity: 1320,
  portfolioChangeCount: 4,
  benchmarkAsset: 'USDT',
};

const sampleTradingReport: TradingReport = {
  ...commonReportProps,
  id: 'TRADING REPORT',
  finalBalance: 1320,
  startBalance: 1000,
  winRate: 60,
  topMAEs: [],
  tradeCount: 10,
};

/** Backs the fs mocks with one file held in memory, for the cases that depend on what was written to it before. */
const useInMemoryFile = (initialContent?: string) => {
  const file = { content: initialContent };
  (fs.existsSync as Mock).mockImplementation(() => file.content !== undefined);
  (fs.statSync as Mock).mockImplementation(() => ({ size: file.content?.length ?? 0 }));
  (fs.writeFileSync as Mock).mockImplementation((_path: string, data: string) => {
    file.content = data;
  });
  (fs.appendFileSync as Mock).mockImplementation((_path: string, data: string) => {
    file.content = `${file.content ?? ''}${data}`;
  });
  (fs.readSync as Mock).mockImplementation((_fd: number, buffer: Buffer) => buffer.write(file.content ?? ''));
  return file;
};

const toLines = (content = '') => content.trimEnd().split('\n');

/** The cells of one line as a CSV reader splits it, each as written: a ';' inside a quoted cell does not end the cell. */
const toCells = (line: string) => {
  const cells = [''];
  let quoted = false;
  for (const char of line) {
    // The doubled double quote of a quoted cell toggles twice, so the cell stays open.
    if (char === '"') quoted = !quoted;
    if (char === ';' && !quoted) cells.push('');
    else cells[cells.length - 1] += char;
  }
  return cells;
};

/** The cell under `column` in the first row of the file, as written (a quoted cell keeps its quotes). */
const cellOf = (content: string | undefined, column: string) => {
  const [header, row] = toLines(content);
  return row !== undefined ? toCells(row)[toCells(header).indexOf(column)] : undefined;
};

describe('PerformanceReporter', () => {
  const releaseMock = vi.fn();
  const lockSyncMock = vi.fn(() => releaseMock);
  let reporter: PerformanceReporter;

  /** A reporter built while the configuration watches `watch` instead of WATCH. */
  const reporterWatching = (watch: Partial<Watch>) => {
    vi.mocked(config.getWatch).mockReturnValueOnce({ ...WATCH, ...watch });
    const watchingReporter = new PerformanceReporter(baseConfig);
    watchingReporter.setFs({ lockSync: lockSyncMock });
    return watchingReporter;
  };

  beforeEach(() => {
    reporter = new PerformanceReporter(baseConfig);
    reporter['setFs']({ lockSync: lockSyncMock });

    // Reset individual mocks instead of clearAllMocks() to adhere to rules
    (fs.mkdirSync as Mock).mockReset();
    (fs.existsSync as Mock).mockReset();
    (fs.writeFileSync as Mock).mockReset();
    (fs.appendFileSync as Mock).mockReset();
    (fs.statSync as Mock).mockReset();
    lockSyncMock.mockClear();
    releaseMock.mockClear();

    // Unless a test says otherwise, a file with content was written by this version.
    (fs.readSync as Mock).mockImplementation((_fd: number, buffer: Buffer) => buffer.write(`${HEADER}\n`));
  });

  describe('#processInit', () => {
    it('should create directories', async () => {
      await reporter['processInit']();
      expect(fs.mkdirSync).toHaveBeenCalledWith(path.dirname(expectedPath), { recursive: true });
    });

    it('should handle errors during directory creation without throwing', async () => {
      const error = new Error('Permission denied');
      (fs.mkdirSync as Mock).mockImplementation(() => {
        throw error;
      });
      expect(() => reporter['processInit']()).not.toThrow();
    });

    it('should log errors during directory creation, by their message', async () => {
      const error = new Error('Permission denied');
      (fs.mkdirSync as Mock).mockImplementation(() => {
        throw error;
      });
      reporter['processInit']();
      const { error: logError } = await import('@services/logger');
      expect(logError).toHaveBeenCalledWith('performance reporter', 'setup error: Permission denied');
    });
  });

  describe('#onPerformanceReport', () => {
    describe('When the file does not exist', () => {
      it.each`
        report
        ${samplePortfolioReport}
        ${sampleTradingReport}
      `('should write the shared header for $report.id', ({ report }) => {
        (fs.existsSync as Mock).mockReturnValue(false);
        (fs.statSync as Mock).mockReturnValue({ size: 0 });

        reporter.onPerformanceReport(report);

        expect(fs.writeFileSync).toHaveBeenCalledWith(expectedPath, `${HEADER}\n`, 'utf8');
      });

      it.each`
        report                   | expectedPart
        ${samplePortfolioReport} | ${'DEMA'}
        ${samplePortfolioReport} | ${'Portfolio'}
        ${sampleTradingReport}   | ${'DEMA'}
        ${sampleTradingReport}   | ${'Trading'}
      `('should append correct parts ($expectedPart) for $report.id', ({ report, expectedPart }) => {
        (fs.existsSync as Mock).mockReturnValue(false);
        (fs.statSync as Mock).mockReturnValue({ size: 0 });

        reporter.onPerformanceReport(report);

        const appendCall = (fs.appendFileSync as Mock).mock.calls[0];
        const writtenLine = appendCall ? (appendCall[1] as string) : '';

        expect(writtenLine).toContain(expectedPart);
      });

      it.each`
        report
        ${samplePortfolioReport}
        ${sampleTradingReport}
      `('should release lock after writing $report.id', ({ report }) => {
        (fs.existsSync as Mock).mockReturnValue(false);
        (fs.statSync as Mock).mockReturnValue({ size: 0 });

        reporter.onPerformanceReport(report);

        expect(releaseMock).toHaveBeenCalled();
      });

      it.each`
        report                   | column                         | value
        ${samplePortfolioReport} | ${'report type'}               | ${'Portfolio'}
        ${samplePortfolioReport} | ${'pair'}                      | ${'BTC/USDT'}
        ${samplePortfolioReport} | ${'timeframe'}                 | ${'1h'}
        ${samplePortfolioReport} | ${'total changes'}             | ${'4'}
        ${samplePortfolioReport} | ${'benchmark asset'}           | ${'USDT'}
        ${samplePortfolioReport} | ${'win rate'}                  | ${''}
        ${samplePortfolioReport} | ${'trade count'}               | ${''}
        ${samplePortfolioReport} | ${'top maes'}                  | ${''}
        ${sampleTradingReport}   | ${'report type'}               | ${'Trading'}
        ${sampleTradingReport}   | ${'pair'}                      | ${'BTC/USDT'}
        ${sampleTradingReport}   | ${'timeframe'}                 | ${'1h'}
        ${sampleTradingReport}   | ${'win rate'}                  | ${'60%'}
        ${sampleTradingReport}   | ${'trade count'}               | ${'10'}
        ${sampleTradingReport}   | ${'top maes'}                  | ${'[]'}
        ${sampleTradingReport}   | ${'max drawdown'}              | ${''}
        ${sampleTradingReport}   | ${'total changes'}             | ${''}
        ${sampleTradingReport}   | ${'longest drawdown duration'} | ${''}
        ${sampleTradingReport}   | ${'benchmark asset'}           | ${''}
        ${samplePortfolioReport} | ${'status'}                    | ${'completed'}
        ${sampleTradingReport}   | ${'status'}                    | ${'completed'}
      `('should write $value under $column for $report.id', ({ report, column, value }) => {
        const file = useInMemoryFile();

        reporter.onPerformanceReport(report);

        expect(cellOf(file.content, column)).toBe(value);
      });
    });

    describe('When the report holds amounts and prices', () => {
      // Whatever the locale of the machine: Node formats with it by default, and vitest runs under Node.
      it.each`
        description                                 | report                                                  | column             | value
        ${'the yearly profit without grouping'}     | ${samplePortfolioReport}                                | ${'yearly profit'} | ${'3650 (116.8%)'}
        ${'the final balance without grouping'}     | ${sampleTradingReport}                                  | ${'final balance'} | ${'1320'}
        ${'a large balance without grouping'}       | ${{ ...samplePortfolioReport, startEquity: 1234.5678 }} | ${'start balance'} | ${'1234.5678'}
        ${'a tiny price'}                           | ${{ ...sampleTradingReport, startPrice: 0.0000012 }}    | ${'start price'}   | ${'0.0000012'}
        ${'a price below 1e-6 without an exponent'} | ${{ ...samplePortfolioReport, endPrice: 0.00000012 }}   | ${'end price'}     | ${'0.00000012'}
        ${'a net profit in BTC'}                    | ${{ ...samplePortfolioReport, netProfit: 0.00042 }}     | ${'net profit'}    | ${'0.00042'}
        ${'a net profit rounded to 8 decimals'}     | ${{ ...sampleTradingReport, netProfit: 0.123456789 }}   | ${'net profit'}    | ${'0.12345679'}
        ${'a final balance that is not a number'}   | ${{ ...sampleTradingReport, finalBalance: NaN }}        | ${'final balance'} | ${''}
        ${'a start price that is missing'}          | ${{ ...samplePortfolioReport, startPrice: undefined }}  | ${'start price'}   | ${''}
      `('should write $value under $column for $description', ({ report, column, value }) => {
        const file = useInMemoryFile();

        reporter.onPerformanceReport(report);

        expect(cellOf(file.content, column)).toBe(value);
      });

      // Still a JSON array of numbers, each written as the amounts are: JSON.stringify wrote every digit of the binary values, and an
      // exponent below 1e-6
      it.each`
        description                      | topMAEs                                            | value
        ${'up to 8 decimals'}            | ${[33.33333333333333, 9.090909090909099]}          | ${'[33.33333333,9.09090909]'}
        ${'without an exponent'}         | ${[0.000031249995123554724, 1.000000338535756e-8]} | ${'[0.00003125,0.00000001]'}
        ${'an MAE of 0 and a round one'} | ${[4.5, 0]}                                        | ${'[4.5,0]'}
      `('should write the top MAEs $description under top maes: $value', ({ topMAEs, value }) => {
        const file = useInMemoryFile();

        reporter.onPerformanceReport({ ...sampleTradingReport, topMAEs });

        expect(cellOf(file.content, 'top maes')).toBe(value);
      });
    });

    // From the epoch, on the UTC calendar: the same on every host. On the host's, a host in a zone that had daylight saving time in 1970
    // (New York) wrote 120 days "3 months 30 days 1 hour"
    describe.each`
      timeZone
      ${'UTC'}
      ${'Europe/Paris'}
      ${'America/New_York'}
    `('When the report of a run on a host in $timeZone has a longest drawdown', ({ timeZone }) => {
      useTimeZone(timeZone);

      it.each`
        longestDrawdownMs | value
        ${9_000_000}      | ${'2 hours 30 minutes'}
        ${30 * DAY}       | ${'30 days'}
        ${59 * DAY}       | ${'2 months'}
        ${120 * DAY}      | ${'4 months'}
        ${200 * DAY}      | ${'6 months 19 days'}
        ${400 * DAY}      | ${'1 year 1 month 4 days'}
      `('should write a longest drawdown of $longestDrawdownMs ms as $value', ({ longestDrawdownMs, value }) => {
        const file = useInMemoryFile();

        reporter.onPerformanceReport({ ...samplePortfolioReport, longestDrawdownMs });

        expect(cellOf(file.content, 'longest drawdown duration')).toBe(value);
      });
    });

    describe('When the run stopped before its end', () => {
      it.each`
        description                                 | report                                                                                            | value
        ${'the reason of a portfolio report'}       | ${{ ...samplePortfolioReport, interruption: 'Missing candles' }}                                  | ${'interrupted: Missing candles'}
        ${'the reason of a trading report'}         | ${{ ...sampleTradingReport, interruption: 'Max consecutive order errors reached (5)' }}           | ${'interrupted: Max consecutive order errors reached (5)'}
        ${'a reason holding the separator, quoted'} | ${{ ...sampleTradingReport, interruption: 'Max consecutive order errors reached (5); stopping' }} | ${'"interrupted: Max consecutive order errors reached (5); stopping"'}
      `('should write $value under status for $description', ({ report, value }) => {
        const file = useInMemoryFile();

        reporter.onPerformanceReport(report);

        expect(cellOf(file.content, 'status')).toBe(value);
      });

      it('should write a row with as many columns as the header when the reason holds the separator', () => {
        const file = useInMemoryFile();

        reporter.onPerformanceReport({ ...sampleTradingReport, interruption: 'Max consecutive order errors reached (5); stopping' });

        expect(toCells(toLines(file.content)[1])).toHaveLength(HEADER_COLUMN_COUNT);
      });

      // An error without a message still stopped the run
      it('should write the row of a run stopped by an error without a message as interrupted', () => {
        useInMemoryFile();

        reporter.onPerformanceReport({ ...samplePortfolioReport, interruption: '' });

        expect(fs.appendFileSync).toHaveBeenCalledWith(expectedPath, expect.stringMatching(/;interrupted: \n$/), 'utf8');
      });
    });

    describe('When the run watches several pairs', () => {
      it('should write every watched pair under pair, separated by a space', () => {
        const file = useInMemoryFile();
        const portfolioReporter = reporterWatching({ assets: ['BTC', 'ETH'], pairs: [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }] });

        portfolioReporter.onPerformanceReport(samplePortfolioReport);

        expect(cellOf(file.content, 'pair')).toBe('BTC/USDT ETH/USDT');
      });
    });

    describe('When the watch has no timeframe', () => {
      it('should leave the timeframe column empty', () => {
        const file = useInMemoryFile();

        reporterWatching({ timeframe: undefined }).onPerformanceReport(samplePortfolioReport);

        expect(cellOf(file.content, 'timeframe')).toBe('');
      });
    });

    describe('When a strategy parameter holds the separator', () => {
      /** Writes the row of a run whose strategy block has a ';' in a parameter, and returns the file. */
      const writeRowWithSeparatorInStrategy = () => {
        const file = useInMemoryFile();
        vi.mocked(config.getStrategy).mockReturnValueOnce({ name: 'grid', sides: 'buy;sell' });
        const gridReporter = new PerformanceReporter(baseConfig);
        gridReporter.setFs({ lockSync: lockSyncMock });
        gridReporter.onPerformanceReport(samplePortfolioReport);
        return file;
      };

      it('should quote the id cell', () => {
        const file = writeRowWithSeparatorInStrategy();

        expect(cellOf(file.content, 'id')).toBe('"grid-buy;sell"');
      });

      it('should write a row with as many columns as the header', () => {
        const file = writeRowWithSeparatorInStrategy();

        expect(toCells(toLines(file.content)[1])).toHaveLength(HEADER_COLUMN_COUNT);
      });
    });

    describe('When the file is empty', () => {
      it.each`
        report
        ${samplePortfolioReport}
        ${sampleTradingReport}
      `('should write the header then the $report.id row', ({ report }) => {
        const file = useInMemoryFile('');

        reporter.onPerformanceReport(report);

        expect(toLines(file.content)).toEqual([HEADER, expect.stringMatching(/^DEMA;/)]);
      });
    });

    describe('When file exists', () => {
      it('should not write header if file exists and has content', () => {
        (fs.existsSync as Mock).mockReturnValue(true);
        (fs.statSync as Mock).mockReturnValue({ size: 100 });

        reporter.onPerformanceReport(samplePortfolioReport);

        expect(fs.writeFileSync).not.toHaveBeenCalled();
      });

      it('should append report line if file exists and has content', () => {
        (fs.existsSync as Mock).mockReturnValue(true);
        (fs.statSync as Mock).mockReturnValue({ size: 100 });

        reporter.onPerformanceReport(samplePortfolioReport);

        expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
      });

      it.each`
        first                    | second
        ${samplePortfolioReport} | ${sampleTradingReport}
        ${sampleTradingReport}   | ${samplePortfolioReport}
      `('should append a $second.id row with as many columns as the header after a $first.id row', ({ first, second }) => {
        const file = useInMemoryFile();

        reporter.onPerformanceReport(first);
        reporter.onPerformanceReport(second);

        expect(toLines(file.content).map(line => toCells(line).length)).toEqual([
          HEADER_COLUMN_COUNT,
          HEADER_COLUMN_COUNT,
          HEADER_COLUMN_COUNT,
        ]);
      });
    });

    describe('When other runs write the same file', () => {
      /** Holds the file in memory and records the lock, the writes and the release, in the order they happen. */
      const recordCalls = (initialContent?: string) => {
        useInMemoryFile(initialContent);
        const calls: string[] = [];
        const record = (mock: Mock, call: string) => {
          const implementation = mock.getMockImplementation();
          mock.mockImplementation((...args: unknown[]) => {
            calls.push(call);
            return implementation?.(...args);
          });
        };
        record(lockSyncMock, 'lock');
        record(fs.writeFileSync as Mock, 'write header');
        record(fs.appendFileSync as Mock, 'append row');
        record(releaseMock, 'release');
        return calls;
      };

      it.each`
        file                                 | content                        | calls
        ${'a new file'}                      | ${undefined}                   | ${['lock', 'write header', 'append row', 'release']}
        ${'an empty file'}                   | ${''}                          | ${['lock', 'write header', 'append row', 'release']}
        ${'a file holding the header'}       | ${`${HEADER}\n`}               | ${['lock', 'append row', 'release']}
        ${'a file of another column layout'} | ${`${OLD_PORTFOLIO_HEADER}\n`} | ${['lock', 'release']}
      `('should take one lock around the header check and the writes, for $file', ({ content, calls }) => {
        const recorded = recordCalls(content);

        reporter.onPerformanceReport(samplePortfolioReport);

        expect(recorded).toEqual(calls);
      });

      it('should retry the lock 5 times, 25 to 75 ms apart', () => {
        useInMemoryFile(`${HEADER}\n`);

        reporter.onPerformanceReport(samplePortfolioReport);

        expect(lockSyncMock).toHaveBeenCalledWith(expectedPath, {
          retries: 5,
          retryDelayMs: expect.toSatisfy((delay: number) => Number.isInteger(delay) && delay >= 25 && delay <= 75, 'from 25 to 75 ms'),
        });
      });

      it('should not write the header again when another run wrote it while this one waited for the lock', () => {
        const file = useInMemoryFile();
        lockSyncMock.mockImplementationOnce(() => {
          // The run that held the lock wrote the header and its row.
          file.content = `${HEADER}\nRSI;Portfolio\n`;
          return releaseMock;
        });

        reporter.onPerformanceReport(samplePortfolioReport);

        expect(toLines(file.content)).toEqual([HEADER, 'RSI;Portfolio', expect.stringMatching(/^DEMA;Portfolio;/)]);
      });
    });

    describe('When the file cannot be locked', () => {
      const lockError = new Error(`Could not acquire lock for ${expectedPath} after 6 attempts`);

      beforeEach(() => {
        lockSyncMock.mockImplementation(() => {
          throw lockError;
        });
      });

      it('should log an error naming the report and the file, saying that the report is lost', async () => {
        useInMemoryFile(`${HEADER}\n`);

        reporter.onPerformanceReport(sampleTradingReport);

        const { error: logError } = await import('@services/logger');
        expect(logError).toHaveBeenCalledWith(
          'performance reporter',
          `report lost: TRADING REPORT not written, ${expectedPath} could not be locked (${lockError.message})`,
        );
      });

      it.each`
        file                           | content
        ${'a new file'}                | ${undefined}
        ${'a file holding the header'} | ${`${HEADER}\n`}
      `('should leave $file as it was', ({ content }) => {
        const file = useInMemoryFile(content);

        reporter.onPerformanceReport(sampleTradingReport);

        expect(file.content).toBe(content);
      });

      it('should not throw', () => {
        useInMemoryFile(`${HEADER}\n`);

        expect(() => reporter.onPerformanceReport(sampleTradingReport)).not.toThrow();
      });

      // Releasing deletes the lock file, which would be the lock of the run that holds it.
      it('should not release a lock it does not hold', () => {
        useInMemoryFile(`${HEADER}\n`);

        reporter.onPerformanceReport(sampleTradingReport);

        expect(releaseMock).not.toHaveBeenCalled();
      });
    });

    describe('When the first line of the file is not the expected header', () => {
      it.each`
        description                                      | content
        ${'the old portfolio report header'}             | ${`${OLD_PORTFOLIO_HEADER}\nDEMA;Portfolio;100\n`}
        ${'the old trading report header'}               | ${`${OLD_TRADING_HEADER}\nDEMA;Trading;100\n`}
        ${'the old portfolio report header with status'} | ${`${OLD_PORTFOLIO_HEADER};status\nDEMA;Portfolio;100\n`}
        ${'the old trading report header with status'}   | ${`${OLD_TRADING_HEADER};status\nDEMA;Trading;100\n`}
        ${'a header without the timeframe column'}       | ${`${HEADER.replace(';timeframe', '')}\nDEMA;Portfolio;100\n`}
        ${'a header with one more column'}               | ${`${HEADER};extra\nDEMA;Portfolio;100\n`}
        ${'a header with one column less (no status)'}   | ${`${HEADER.slice(0, HEADER.lastIndexOf(';'))}\nDEMA;Portfolio;100\n`}
        ${'a row, the file having no header'}            | ${'DEMA;Portfolio;100\nDEMA;Portfolio;100\n'}
        ${'the header without its line break'}           | ${HEADER}
        ${'the header ended by a lone carriage return'}  | ${`${HEADER}\rDEMA;Portfolio;100\r`}
        ${'a byte order mark and an old header'}         | ${`\uFEFF${OLD_TRADING_HEADER}\r\nDEMA;Trading;100\r\n`}
      `('should not append to a file holding $description', ({ content }) => {
        const file = useInMemoryFile(content);

        reporter.onPerformanceReport(sampleTradingReport);

        expect(file.content).toBe(content);
      });

      it('should log an error naming the file and saying what is checked', async () => {
        useInMemoryFile(`${OLD_PORTFOLIO_HEADER}\n`);

        reporter.onPerformanceReport(sampleTradingReport);

        const { error: logError } = await import('@services/logger');
        expect(logError).toHaveBeenCalledWith(
          'performance reporter',
          `report not written: the first line of ${expectedPath} is not the expected header (another column layout or an older version of this plugin): move or rename it`,
        );
      });
    });

    describe('When a spreadsheet saved the file back', () => {
      it.each`
        description                                  | content
        ${'CRLF line endings'}                       | ${`${HEADER}\r\nRSI;Portfolio\r\n`}
        ${'a byte order mark'}                       | ${`\uFEFF${HEADER}\nRSI;Portfolio\n`}
        ${'a byte order mark and CRLF line endings'} | ${`\uFEFF${HEADER}\r\nRSI;Portfolio\r\n`}
      `('should append the row to a file with $description', ({ content }) => {
        useInMemoryFile(content);

        reporter.onPerformanceReport(samplePortfolioReport);

        expect(fs.appendFileSync).toHaveBeenCalledWith(expectedPath, expect.stringMatching(/^DEMA;Portfolio;[^\n]*\n$/), 'utf8');
      });
    });

    describe('Edge Cases & Errors', () => {
      it('should ignore empty payloads or invalid objects (if passed as array by mistake handled at types or runtime)', () => {
        reporter.onPerformanceReport([] as any);
        expect(fs.appendFileSync).not.toHaveBeenCalled();
      });

      it('should not write header for empty payload', () => {
        reporter.onPerformanceReport([] as any);
        expect(fs.writeFileSync).not.toHaveBeenCalled();
      });

      it('should ignore unknown report types', () => {
        const unknownReport = { ...samplePortfolioReport, id: 'UNKNOWN' as any };
        reporter.onPerformanceReport(unknownReport);
        expect(fs.appendFileSync).not.toHaveBeenCalled();
      });

      // Described, not interpolated: String() wrote an Error with its name, a GekkoError with its own tag after the reporter's, and
      // threw for a value without a prototype, from the catch itself
      it.each`
        kind                               | thrown                                                | logged
        ${'an Error'}                      | ${new Error('Disk full')}                             | ${'write error: Disk full'}
        ${'a GekkoError, without its tag'} | ${new GekkoError('storage', 'Disk full')}             | ${'write error: Disk full'}
        ${'a string'}                      | ${'EIO'}                                              | ${'write error: EIO'}
        ${'a value without a prototype'}   | ${Object.assign(Object.create(null), { errno: -28 })} | ${'write error: [Object: null prototype] { errno: -28 }'}
      `('should log a write error, $kind thrown: $logged', async ({ thrown, logged }) => {
        (fs.existsSync as Mock).mockReturnValue(true);
        (fs.statSync as Mock).mockReturnValue({ size: 100 });
        (fs.appendFileSync as Mock).mockImplementation(() => {
          throw thrown;
        });

        reporter.onPerformanceReport(samplePortfolioReport);

        const { error: logError } = await import('@services/logger');
        expect(logError).toHaveBeenCalledWith('performance reporter', logged);
      });

      it('should release lock even on write error', () => {
        (fs.existsSync as Mock).mockReturnValue(true);
        (fs.statSync as Mock).mockReturnValue({ size: 100 });
        const error = new Error('Disk full');
        (fs.appendFileSync as Mock).mockImplementation(() => {
          throw error;
        });

        reporter.onPerformanceReport(samplePortfolioReport);

        expect(releaseMock).toHaveBeenCalled();
      });

      describe('When the first line of the file cannot be read', () => {
        beforeEach(() => {
          (fs.existsSync as Mock).mockReturnValue(true);
          (fs.statSync as Mock).mockReturnValue({ size: 100 });
          (fs.openSync as Mock).mockReturnValue(42);
          (fs.readSync as Mock).mockImplementation(() => {
            throw new Error('EIO');
          });
        });

        it('should log a write error', async () => {
          reporter.onPerformanceReport(samplePortfolioReport);

          const { error: logError } = await import('@services/logger');
          expect(logError).toHaveBeenCalledWith('performance reporter', 'write error: EIO');
        });

        it('should not append the row', () => {
          reporter.onPerformanceReport(samplePortfolioReport);

          expect(fs.appendFileSync).not.toHaveBeenCalled();
        });

        it('should close the file', () => {
          reporter.onPerformanceReport(samplePortfolioReport);

          expect(fs.closeSync).toHaveBeenCalledWith(42);
        });

        it('should release the lock', () => {
          reporter.onPerformanceReport(samplePortfolioReport);

          expect(releaseMock).toHaveBeenCalledOnce();
        });
      });

      it('should format winRate as N/A when null', () => {
        const report = { ...sampleTradingReport, winRate: null as any };
        (fs.existsSync as Mock).mockReturnValue(true);
        (fs.statSync as Mock).mockReturnValue({ size: 100 });

        reporter.onPerformanceReport(report);

        const appendCall = (fs.appendFileSync as Mock).mock.calls[0];
        const writtenLine = appendCall ? (appendCall[1] as string) : '';
        expect(writtenLine).toContain('N/A');
      });

      it('should handle zero drawdown correctly for portfolio', () => {
        const report = { ...samplePortfolioReport, longestDrawdownMs: 0 };
        (fs.existsSync as Mock).mockReturnValue(true);
        (fs.statSync as Mock).mockReturnValue({ size: 100 });

        reporter.onPerformanceReport(report);

        const appendCall = (fs.appendFileSync as Mock).mock.calls[0];
        const writtenLine = appendCall ? (appendCall[1] as string) : '';
        expect(writtenLine).toContain(';0;');
      });
    });
  });

  describe('#processOneMinuteBucket', () => {
    it('should not throw', () => {
      expect(() => reporter['processOneMinuteBucket']()).not.toThrow();
    });
  });

  describe('#processFinalize', () => {
    it('should not throw', () => {
      expect(() => reporter['processFinalize']()).not.toThrow();
    });
  });

  describe('#getStaticConfiguration', () => {
    it('should return the expected static metadata config', () => {
      const meta = PerformanceReporter.getStaticConfiguration();
      expect(meta).toMatchObject({
        name: 'PerformanceReporter',
        modes: expect.arrayContaining(['backtest']),
      });
    });

    it('should have a schema', () => {
      const meta = PerformanceReporter.getStaticConfiguration();
      expect(meta.schema).toBeDefined();
    });
  });
});
