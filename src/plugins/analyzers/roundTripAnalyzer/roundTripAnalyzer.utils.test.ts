import { RoundTrip } from '@models/event.types';
import { info } from '@services/logger';
import { useTimeZone } from '@utils/date/date.mock';
import { beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import { TradingReport } from './roundTrip.types';
import { logFinalize, logRoundtrip } from './roundTripAnalyzer.utils';

vi.mock('@services/logger', () => ({ info: vi.fn() }));

// A round trip on ETH/BTC: its P&L is a fraction of a BTC.
const roundTrip: RoundTrip = {
  id: 1,
  entryAt: 1748563200000,
  entryPrice: 0.05,
  entryEquity: 0.1,
  exitAt: 1748566800000,
  exitPrice: 0.0502,
  exitEquity: 0.10042,
  duration: 3600000,
  maxAdverseExcursion: 1.5,
  profit: 0.42,
  pnl: 0.00042,
};

// A run on PEPE/USDT: its prices are a fraction of a cent.
const report: TradingReport = {
  id: 'TRADING REPORT',
  alpha: 1.5,
  downsideDeviation: 0.5,
  periodStartAt: 1748563200000,
  periodEndAt: 1748649600000,
  exposurePct: 50,
  marketReturnPct: 8.33,
  netProfit: 234.5678,
  totalReturnPct: 23.45,
  annualizedReturnPct: 116.8,
  sharpeRatio: 1.25,
  sortinoRatio: 1.1,
  volatility: 2.5,
  startPrice: 0.0000012,
  endPrice: 0.0000013,
  formattedDuration: '1 day',
  annualizedNetProfit: 85617.247,
  finalBalance: 1234.5678,
  startBalance: 1000,
  winRate: 60,
  topMAEs: [1.5],
  tradeCount: 10,
};

describe('roundTripAnalyzer.utils', () => {
  let consoleTable: MockInstance<typeof console.table>;

  /** The row printed by the last console.table call. */
  const printedRow = () => consoleTable.mock.lastCall?.[0];

  beforeEach(() => {
    consoleTable = vi.spyOn(console, 'table').mockImplementation(() => {});
  });

  describe('logRoundtrip', () => {
    it.each`
      description                             | pnl          | currency  | expected
      ${'a P&L of a fraction of a BTC'}       | ${0.00042}   | ${'BTC'}  | ${'0.00042 BTC'}
      ${'a loss of a fraction of a BTC'}      | ${-0.00042}  | ${'BTC'}  | ${'-0.00042 BTC'}
      ${'a large P&L, its thousands grouped'} | ${1234.5678} | ${'USDT'} | ${'1,234.5678 USDT'}
    `('should print $description as $expected', ({ pnl, currency, expected }) => {
      logRoundtrip({ ...roundTrip, pnl }, currency, true);

      expect(printedRow()['P&L']).toBe(expected);
    });

    // A round trip that no portfolio read valued has neither a P&L nor a profit (NaN): written as they come, they read as figures. Its
    // percentages are rounded down to 2 decimals, as on Telegram (see PERCENT_ROUNDING)
    it.each`
      field       | fields                            | expected
      ${'P&L'}    | ${{ pnl: NaN }}                   | ${'unknown'}
      ${'profit'} | ${{ profit: NaN }}                | ${'unknown'}
      ${'profit'} | ${{ profit: 0.42 }}               | ${'0.42%'}
      ${'profit'} | ${{ profit: -0.5 }}               | ${'-0.5%'}
      ${'profit'} | ${{ profit: -5.001 }}             | ${'-5.01%'}
      ${'profit'} | ${{ profit: 3.125 }}              | ${'3.12%'}
      ${'MAE'}    | ${{ maxAdverseExcursion: 3.125 }} | ${'3.12%'}
      ${'MAE'}    | ${{ maxAdverseExcursion: 1.005 }} | ${'1%'}
    `('should print $field $expected for a round trip with $fields', ({ field, fields, expected }) => {
      logRoundtrip({ ...roundTrip, ...fields }, 'BTC', true);

      expect(printedRow()[field]).toBe(expected);
    });

    describe.each`
      timeZone
      ${'UTC'}
      ${'Europe/Paris'}
      ${'America/New_York'}
      ${'America/Santiago'}
    `('on a host in $timeZone', ({ timeZone }) => {
      useTimeZone(timeZone);

      // Counted from epoch 0 on the UTC calendar: on the host's, New York moved its clocks on 1970-04-26, and every duration that
      // reached past it gained an hour (Paris did not change its clocks in 1970). Through the TZDate of @date-fns/tz for 'UTC', a
      // duration ending on a UTC midnight that the host's zone skipped lost an hour: 283 days read "9 months 10 days -1 hours" in
      // Santiago, which moved its clocks at midnight then
      it.each`
        duration                                       | expected
        ${60_000}                                      | ${'1 minute'}
        ${3 * 86_400_000 + 5 * 3_600_000 + 7 * 60_000} | ${'3 days 5 hours 7 minutes'}
        ${116 * 86_400_000}                            | ${'3 months 26 days'}
        ${200 * 86_400_000}                            | ${'6 months 19 days'}
        ${283 * 86_400_000}                            | ${'9 months 10 days'}
        ${400 * 86_400_000}                            | ${'1 year 1 month 4 days'}
      `('should print an exposed duration of $duration ms as $expected', ({ duration, expected }) => {
        logRoundtrip({ ...roundTrip, duration }, 'BTC', true);

        expect(printedRow().exposedDuration).toBe(expected);
      });
    });

    it('should not print a table when the console table is disabled', () => {
      logRoundtrip(roundTrip, 'BTC', false);

      expect(consoleTable).not.toHaveBeenCalled();
    });

    it.each`
      enableConsoleTable
      ${true}
      ${false}
    `('should log the round trip through info when enableConsoleTable is $enableConsoleTable', ({ enableConsoleTable }) => {
      logRoundtrip(roundTrip, 'BTC', enableConsoleTable);

      expect(info).toHaveBeenCalledWith('roundtrip analyzer', roundTrip);
    });
  });

  describe('logFinalize', () => {
    it.each`
      description                                 | tradingReport                                  | field                    | expected
      ${'a start price of a fraction of a cent'}  | ${report}                                      | ${'startPrice'}          | ${'0.0000012 USDT'}
      ${'an end price of a fraction of a cent'}   | ${report}                                      | ${'endPrice'}            | ${'0.0000013 USDT'}
      ${'a start balance without decimals'}       | ${report}                                      | ${'startBalance'}        | ${'1,000 USDT'}
      ${'a final balance, its thousands grouped'} | ${report}                                      | ${'finalBalance'}        | ${'1,234.5678 USDT'}
      ${'a large yearly profit with its return'}  | ${report}                                      | ${'annualizedNetProfit'} | ${'85,617.247 USDT (116.8%)'}
      ${'a tiny yearly profit with its return'}   | ${{ ...report, annualizedNetProfit: 0.00042 }} | ${'annualizedNetProfit'} | ${'0.00042 USDT (116.8%)'}
      ${'an amount rounded to 8 decimals'}        | ${{ ...report, finalBalance: 0.123456789 }}    | ${'finalBalance'}        | ${'0.12345679 USDT'}
      ${'the win rate'}                           | ${report}                                      | ${'winRate'}             | ${'60%'}
      ${'no win rate without a round trip'}       | ${{ ...report, winRate: null }}                | ${'winRate'}             | ${'N/A'}
    `('should print $description under $field', ({ tradingReport, field, expected }) => {
      logFinalize(tradingReport, 'USDT');

      expect(printedRow()[field]).toBe(expected);
    });

    // As the CSV writes them (see PERCENT_ROUNDING, formatRatio): a win rate of 3.125 % read 3.13 % here, rounded half up, and 3.12 %
    // there; the downside deviation, a ratio there as the volatility is here, read 1.23 % for the 1.24 of the CSV
    it.each`
      field                    | fields                                     | expected
      ${'marketReturnPct'}     | ${{ marketReturnPct: -5.001 }}             | ${'-5.01%'}
      ${'marketReturnPct'}     | ${{ marketReturnPct: 3.125 }}              | ${'3.12%'}
      ${'alpha'}               | ${{ alpha: -5.001 }}                       | ${'-5.01%'}
      ${'alpha'}               | ${{ alpha: 3.125 }}                        | ${'3.12%'}
      ${'annualizedNetProfit'} | ${{ annualizedReturnPct: -5.001 }}         | ${'85,617.247 USDT (-5.01%)'}
      ${'annualizedNetProfit'} | ${{ annualizedReturnPct: 3.125 }}          | ${'85,617.247 USDT (3.12%)'}
      ${'exposurePct'}         | ${{ exposurePct: -5.001 }}                 | ${'-5% of time exposed'}
      ${'exposurePct'}         | ${{ exposurePct: 3.125 }}                  | ${'3.12% of time exposed'}
      ${'winRate'}             | ${{ winRate: -5.001 }}                     | ${'-5%'}
      ${'winRate'}             | ${{ winRate: 3.125 }}                      | ${'3.12%'}
      ${'downsideDeviation'}   | ${{ downsideDeviation: 1.239 }}            | ${'1.24'}
      ${'volatility'}          | ${{ volatility: 1.239 }}                   | ${'1.24'}
      ${'topMAEs'}             | ${{ topMAEs: [3.125, 1.005, 0.00000012] }} | ${'3.12%, 1%, 0%'}
    `('should print $field $expected for a report with $fields', ({ field, fields, expected }) => {
      logFinalize({ ...report, ...fields }, 'USDT');

      expect(printedRow()[field]).toBe(expected);
    });
  });
});
