import { useTimeZone } from '@utils/date/date.mock';
import { beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import { PortfolioReport } from './portfolioAnalyzer.types';
import { logPortfolioReport } from './portfolioAnalyzer.helper';

const DAY = 86_400_000;

describe('logPortfolioReport', () => {
  const mockReport: PortfolioReport = {
    id: 'PORTFOLIO PROFIT REPORT',
    netProfit: 100.5,
    totalReturnPct: 10.5,
    maxDrawdownPct: 5.2,
    sharpeRatio: 1.5,
    alpha: 0,
    downsideDeviation: 0,
    periodEndAt: 0,
    periodStartAt: 0,
    exposurePct: 0,
    marketReturnPct: 0,
    annualizedReturnPct: 0,
    sortinoRatio: 0,
    volatility: 0,
    startPrice: 0,
    endPrice: 0,
    formattedDuration: '',
    annualizedNetProfit: 0,
    equityCurve: [],
    longestDrawdownMs: 0,
    startEquity: 0,
    endEquity: 0,
    portfolioChangeCount: 0,
    benchmarkAsset: 'BTC',
  };

  let consoleTable: MockInstance<typeof console.table>;
  let consoleLog: MockInstance<typeof console.log>;

  beforeEach(() => {
    consoleTable = vi.spyOn(console, 'table').mockImplementation(() => {});
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('should print every metric of the report', () => {
    logPortfolioReport(mockReport, 'USD');

    expect(consoleTable).toHaveBeenCalledWith({
      'Net Profit': '100.5 USD',
      'Annualized Net Profit': '0 USD',
      'Total Return %': '10.5%',
      'Annualized Return %': '0%',
      'Market Return %': '0%',
      'Max Drawdown %': '5.2%',
      'Longest Drawdown': '0',
      Alpha: '0%',
      'Sharpe Ratio': '1.50',
      'Sortino Ratio': '0.00',
      Volatility: '0.00',
      'Downside Deviation': '0.00',
      'Start Equity': '0 USD',
      'End Equity': '0 USD',
      'Start Price': '0 USD',
      'End Price': '0 USD',
      Benchmark: 'BTC',
      Changes: 0,
      'Period Start': '1970-01-01T00:00:00.000Z',
      'Period End': '1970-01-01T00:00:00.000Z',
      Duration: '',
      'Exposure %': '0%',
    });
  });

  // The table replaces the info line of the report: the bounds of the period, in the line and the CSV, were missing from it
  it.each`
    field             | fields                              | expected
    ${'Period Start'} | ${{ periodStartAt: 1748563200000 }} | ${'2025-05-30T00:00:00.000Z'}
    ${'Period End'}   | ${{ periodEndAt: 1748649600000 }}   | ${'2025-05-31T00:00:00.000Z'}
  `('should print $expected under $field for a report with $fields', ({ field, fields, expected }) => {
    logPortfolioReport({ ...mockReport, ...fields }, 'USD');

    expect(consoleTable.mock.lastCall?.[0][field]).toBe(expected);
  });

  // As the CSV writes it: counted from the epoch on the UTC calendar, the same on every host (see formatDurationUTC)
  describe.each`
    timeZone
    ${'UTC'}
    ${'Europe/Paris'}
    ${'America/New_York'}
  `('on a host in $timeZone', ({ timeZone }) => {
    useTimeZone(timeZone);

    it.each`
      longestDrawdownMs | expected
      ${9_000_000}      | ${'2 hours 30 minutes'}
      ${120 * DAY}      | ${'4 months'}
      ${400 * DAY}      | ${'1 year 1 month 4 days'}
    `('should print a longest drawdown of $longestDrawdownMs ms as $expected', ({ longestDrawdownMs, expected }) => {
      logPortfolioReport({ ...mockReport, longestDrawdownMs }, 'USD');

      expect(consoleTable.mock.lastCall?.[0]['Longest Drawdown']).toBe(expected);
    });
  });

  // As the CSV writes it: 0, where formatDurationUTC writes nothing for a duration of 0, which read as a figure missing
  it('should print a longest drawdown of 0 for a report without a drawdown', () => {
    logPortfolioReport({ ...mockReport, longestDrawdownMs: 0 }, 'USD');

    expect(consoleTable.mock.lastCall?.[0]['Longest Drawdown']).toBe('0');
  });

  // The report of a run stopped before its end covers a partial period, which the table alone showed as a complete one
  describe('for a run stopped before its end', () => {
    it('should print "Run interrupted, the report below covers a partial period. Reason: [STRATEGY] Max consecutive order errors reached (5)" once', () => {
      logPortfolioReport({ ...mockReport, interruption: '[STRATEGY] Max consecutive order errors reached (5)' }, 'USD');

      expect(consoleLog.mock.calls).toEqual([
        ['Run interrupted, the report below covers a partial period. Reason: [STRATEGY] Max consecutive order errors reached (5)'],
      ]);
    });

    // An error without a message stopped the run all the same, as the status of the CSV row says
    it('should print "Run interrupted, the report below covers a partial period. Reason: " once for an error without a message', () => {
      logPortfolioReport({ ...mockReport, interruption: '' }, 'USD');

      expect(consoleLog.mock.calls).toEqual([['Run interrupted, the report below covers a partial period. Reason: ']]);
    });

    it('should print that line above the table', () => {
      logPortfolioReport({ ...mockReport, interruption: '[STREAM] Missing candles in database' }, 'USD');

      expect(consoleLog.mock.invocationCallOrder[0]).toBeLessThan(consoleTable.mock.invocationCallOrder[0]);
    });
  });

  it('should print no line beside the table of a run that reached its end', () => {
    logPortfolioReport(mockReport, 'USD');

    expect(consoleLog).not.toHaveBeenCalled();
  });

  // As the CSV writes them (see PERCENT_ROUNDING, formatRatio): rounded to nearest by toFixed, a total return of -5.001 % read -5.00 %
  // here and -5.01 % there, a Sharpe ratio of 1.23456 read 1.2346 and 1.23, and the alpha, in percentage points, had no '%'
  it.each`
    field                    | fields                             | expected
    ${'Total Return %'}      | ${{ totalReturnPct: -5.001 }}      | ${'-5.01%'}
    ${'Total Return %'}      | ${{ totalReturnPct: 3.125 }}       | ${'3.12%'}
    ${'Annualized Return %'} | ${{ annualizedReturnPct: -5.001 }} | ${'-5.01%'}
    ${'Annualized Return %'} | ${{ annualizedReturnPct: 3.125 }}  | ${'3.12%'}
    ${'Market Return %'}     | ${{ marketReturnPct: -5.001 }}     | ${'-5.01%'}
    ${'Market Return %'}     | ${{ marketReturnPct: 3.125 }}      | ${'3.12%'}
    ${'Max Drawdown %'}      | ${{ maxDrawdownPct: -5.001 }}      | ${'-5.01%'}
    ${'Max Drawdown %'}      | ${{ maxDrawdownPct: 3.125 }}       | ${'3.12%'}
    ${'Alpha'}               | ${{ alpha: -5.001 }}               | ${'-5.01%'}
    ${'Alpha'}               | ${{ alpha: 3.125 }}                | ${'3.12%'}
    ${'Exposure %'}          | ${{ exposurePct: -5.001 }}         | ${'-5%'}
    ${'Exposure %'}          | ${{ exposurePct: 3.125 }}          | ${'3.12%'}
    ${'Sharpe Ratio'}        | ${{ sharpeRatio: 1.23456 }}        | ${'1.23'}
    ${'Sortino Ratio'}       | ${{ sortinoRatio: -1.239 }}        | ${'-1.24'}
    ${'Volatility'}          | ${{ volatility: 1.239 }}           | ${'1.24'}
    ${'Downside Deviation'}  | ${{ downsideDeviation: 1.239 }}    | ${'1.24'}
  `('should print $expected under $field for a report with $fields', ({ field, fields, expected }) => {
    logPortfolioReport({ ...mockReport, ...fields }, 'USD');

    expect(consoleTable.mock.lastCall?.[0][field]).toBe(expected);
  });

  // Amounts and prices keep up to 8 decimals: a price of a fraction of a cent or a profit in BTC is not printed as 0.
  it.each`
    description                                     | report                                              | field                      | expected
    ${'a start price of a fraction of a cent'}      | ${{ ...mockReport, startPrice: 0.0000012 }}         | ${'Start Price'}           | ${'0.0000012 USD'}
    ${'an end price of a fraction of a cent'}       | ${{ ...mockReport, endPrice: 0.00000012 }}          | ${'End Price'}             | ${'0.00000012 USD'}
    ${'a net profit of a fraction of a cent'}       | ${{ ...mockReport, netProfit: 0.00042 }}            | ${'Net Profit'}            | ${'0.00042 USD'}
    ${'an annualized loss of a fraction of a cent'} | ${{ ...mockReport, annualizedNetProfit: -0.00042 }} | ${'Annualized Net Profit'} | ${'-0.00042 USD'}
    ${'a start equity, its thousands grouped'}      | ${{ ...mockReport, startEquity: 1234.5678 }}        | ${'Start Equity'}          | ${'1,234.5678 USD'}
    ${'an end equity rounded to 8 decimals'}        | ${{ ...mockReport, endEquity: 0.123456789 }}        | ${'End Equity'}            | ${'0.12345679 USD'}
  `('should print $description under $field', ({ report, field, expected }) => {
    logPortfolioReport(report, 'USD');

    expect(consoleTable.mock.lastCall?.[0][field]).toBe(expected);
  });
});
