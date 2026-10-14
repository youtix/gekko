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

    // A round trip that no portfolio read valued has neither a P&L nor a profit (NaN): written as they come, they read as figures
    it.each`
      field       | fields              | expected
      ${'P&L'}    | ${{ pnl: NaN }}     | ${'unknown'}
      ${'profit'} | ${{ profit: NaN }}  | ${'unknown'}
      ${'profit'} | ${{ profit: 0.42 }} | ${'0.42%'}
      ${'profit'} | ${{ profit: -0.5 }} | ${'-0.5%'}
    `('should print $field $expected for a round trip with $fields', ({ field, fields, expected }) => {
      logRoundtrip({ ...roundTrip, ...fields }, 'BTC', true);

      expect(printedRow()[field]).toBe(expected);
    });

    describe.each`
      timeZone
      ${'UTC'}
      ${'Europe/Paris'}
      ${'America/New_York'}
    `('on a host in $timeZone', ({ timeZone }) => {
      useTimeZone(timeZone);

      // Counted from epoch 0 on the UTC calendar: on the host's, New York moved its clocks on 1970-04-26, and every duration that
      // reached past it gained an hour (Paris did not change its clocks in 1970)
      it.each`
        duration                                       | expected
        ${60_000}                                      | ${'1 minute'}
        ${3 * 86_400_000 + 5 * 3_600_000 + 7 * 60_000} | ${'3 days 5 hours 7 minutes'}
        ${116 * 86_400_000}                            | ${'3 months 26 days'}
        ${200 * 86_400_000}                            | ${'6 months 19 days'}
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
  });
});
