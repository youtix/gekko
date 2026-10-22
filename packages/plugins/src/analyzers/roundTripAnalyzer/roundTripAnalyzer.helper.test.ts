import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import { RoundTrip } from '@gekko/shared/models/event.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { info } from '@gekko/core/logger/logger';
import { useTimeZone } from '@gekko/shared/utils/date/date.mock';
import { beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import { OpenRoundTrip, PairTradingSummary, TradingReport } from './roundTrip.types';
import { LATE_FILL_CANDLES } from './roundTripAnalyzer.const';
import {
  addToMeanPrice,
  countCandle,
  logFinalize,
  logRoundtrip,
  measureAdverseExcursion,
  measureCoveredMs,
  measureRoundTrip,
  priceUncompletedFill,
} from './roundTripAnalyzer.helper';

vi.mock('@gekko/core/logger/logger', () => ({ info: vi.fn() }));

// A round trip on ETH/BTC: its P&L is a fraction of a BTC.
const roundTrip: RoundTrip = {
  id: 1,
  symbol: 'ETH/BTC',
  entryAt: 1748563200000,
  entryPrice: 0.05,
  entryEquity: 0.1,
  exitAt: 1748566800000,
  exitPrice: 0.0502,
  cost: 0.05,
  proceeds: 0.0502,
  fees: 0.00016,
  duration: 3600000,
  maxAdverseExcursion: 1.5,
  profit: 0.04,
  pnl: 0.00004,
};

/** The breakdown of a pair: 3 round trips of 5, 1.5 of P&L, half the period exposed, its deepest excursion 2.5 % */
const pairSummary = (symbol: TradingPair, fields: Partial<PairTradingSummary> = {}): PairTradingSummary => ({
  symbol,
  roundTripCount: 5,
  winCount: 3,
  winRate: 60,
  tradeCount: 10,
  pnl: 1.5,
  exposurePct: 50,
  maxAdverseExcursion: 2.5,
  ...fields,
});

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
  benchmarkAsset: 'PEPE',
  formattedDuration: '1 day',
  annualizedNetProfit: 85617.247,
  finalBalance: 1234.5678,
  startBalance: 1000,
  winRate: 60,
  topMAEs: [1.5],
  tradeCount: 10,
  pairs: [pairSummary('PEPE/USDT')],
};

/** A round trip of 1 BTC entered at 100 and still open, with its own list of deepenings: counting a candle can add to it */
const openRoundTrip = (fields: Partial<OpenRoundTrip> = {}): OpenRoundTrip => ({
  entryOrderId: '11111111-1111-4111-8111-111111111111',
  entryAt: ONE_MINUTE,
  entryPrice: 100,
  entryEquity: 1000,
  bought: 1,
  sold: 0,
  position: 1,
  cost: 100,
  proceeds: 0,
  fees: 0,
  exitPrice: 0,
  maxAdverseExcursion: 0,
  excursionDeepenings: [],
  ...fields,
});

describe('roundTripAnalyzer.helper', () => {
  let consoleTable: MockInstance<typeof console.table>;
  let consoleLog: MockInstance<typeof console.log>;

  /** The row printed by the last console.table call. */
  const printedRow = () => consoleTable.mock.lastCall?.[0];

  beforeEach(() => {
    consoleTable = vi.spyOn(console, 'table').mockImplementation(() => {});
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('addToMeanPrice', () => {
    // In decimal: in binary, 1 at 0.1 and 1 at 0.2 made 0.15000000000000002, and 0.3 at 104.44 and 0.3 at 104.46 made 104.44999999999999
    it.each`
      meanPrice | amount | price     | addedAmount | expected
      ${100}    | ${1}   | ${130}    | ${2}        | ${120}
      ${0}      | ${0}   | ${110}    | ${1}        | ${110}
      ${0.1}    | ${1}   | ${0.2}    | ${1}        | ${0.15}
      ${104.44} | ${0.3} | ${104.46} | ${0.3}      | ${104.45}
      ${100}    | ${0}   | ${100}    | ${0}        | ${NaN}
    `(
      'should make $expected of $amount at $meanPrice and $addedAmount at $price',
      ({ meanPrice, amount, price, addedAmount, expected }) => {
        expect(addToMeanPrice(meanPrice, amount, price, addedAmount)).toBe(expected);
      },
    );
  });

  describe('measureRoundTrip', () => {
    // Prices to 1e-6 and amounts to 1e-4 (ETH/BTC): bought and sold back at its own price without a fee, a round trip costs what it
    // brings in, to the last decimal
    it.each`
      cost           | proceeds          | fees    | entryEquity    | field       | expected               | description
      ${9000}        | ${11000}          | ${20}   | ${300000}      | ${'pnl'}    | ${1980}                | ${'its proceeds less its cost and its fees'}
      ${9000}        | ${11000}          | ${20}   | ${300000}      | ${'profit'} | ${0.66}                | ${'1980 in % of the entry equity'}
      ${11000}       | ${9000}           | ${20}   | ${301980}      | ${'pnl'}    | ${-2020}               | ${'a loss'}
      ${11000}       | ${9000}           | ${20}   | ${301980}      | ${'profit'} | ${-0.668918471421948}  | ${'that loss in % of the entry equity, to 15 significant digits'}
      ${1000}        | ${1000.5}         | ${1}    | ${1001}        | ${'profit'} | ${-0.04995004995005}   | ${'in decimal: (100 * -0.5) / 1001 is -0.04995004995004995'}
      ${100}         | ${110}            | ${0.21} | ${310000}      | ${'profit'} | ${0.00315806451612903} | ${'9.79 in % of a portfolio of 310,000, whatever it held of the asset'}
      ${0.000630178} | ${0.000630178}    | ${0}    | ${0.999}       | ${'pnl'}    | ${0}                   | ${'sold back at its own price without a fee: a break-even'}
      ${1}           | ${1.000000005}    | ${0}    | ${1}           | ${'pnl'}    | ${0}                   | ${'half a unit of the 8th decimal apart: a break-even'}
      ${1}           | ${1.000000005}    | ${0}    | ${1}           | ${'profit'} | ${0}                   | ${'half a unit of the 8th decimal apart: a break-even'}
      ${1}           | ${1.00000001}     | ${0}    | ${1}           | ${'pnl'}    | ${1e-8}                | ${'a unit of the 8th decimal apart, an amount the exchange books'}
      ${1}           | ${1.00000001}     | ${0}    | ${1}           | ${'profit'} | ${0.000001}            | ${'a unit of the 8th decimal apart, an amount the exchange books'}
      ${100_000_000} | ${100_000_000.05} | ${0}    | ${100_000_000} | ${'pnl'}    | ${0}                   | ${'within a billionth of the cost (see compareWithTolerance): a break-even'}
      ${100_000_000} | ${100_000_000.2}  | ${0}    | ${100_000_000} | ${'pnl'}    | ${0.2}                 | ${'beyond a billionth of the cost'}
      ${100}         | ${110}            | ${0.21} | ${NaN}         | ${'pnl'}    | ${9.79}                | ${'known from the fills without an entry equity'}
      ${100}         | ${110}            | ${0.21} | ${NaN}         | ${'profit'} | ${NaN}                 | ${'unknown without an entry equity'}
      ${100}         | ${110}            | ${0.21} | ${0}           | ${'profit'} | ${NaN}                 | ${'unknown with an entry equity of 0, not a gain of Infinity %'}
      ${100}         | ${100}            | ${0}    | ${NaN}         | ${'profit'} | ${NaN}                 | ${'unknown without an entry equity, for a break-even too'}
    `(
      'should measure $field $expected from a cost of $cost, proceeds of $proceeds and fees of $fees, entered with $entryEquity: $description',
      ({ cost, proceeds, fees, entryEquity, field, expected }) => {
        expect(measureRoundTrip({ cost, proceeds, fees }, entryEquity)[field as 'pnl' | 'profit']).toBe(expected);
      },
    );
  });

  describe('measureCoveredMs', () => {
    // A period from minute 10 to minute 20
    const PERIOD = { start: 10 * ONE_MINUTE, end: 20 * ONE_MINUTE };
    /** Intervals given in minutes */
    const minutes = (...spans: [number, number][]) => spans.map(([start, end]) => ({ start: start * ONE_MINUTE, end: end * ONE_MINUTE }));

    it.each`
      intervals                                | covered | description
      ${[]}                                    | ${0}    | ${'nothing without an interval'}
      ${minutes([12, 15])}                     | ${3}    | ${'an interval within the period, in full'}
      ${minutes([8, 15])}                      | ${5}    | ${'an interval entered before the start, from the start'}
      ${minutes([15, 22])}                     | ${5}    | ${'an interval exited after the end, until the end'}
      ${minutes([2, 8])}                       | ${0}    | ${'an interval before the period, not at all'}
      ${minutes([21, 22])}                     | ${0}    | ${'an interval after the period, not at all'}
      ${minutes([12, 15], [17, 19])}           | ${5}    | ${'two intervals apart, added up'}
      ${minutes([12, 16], [14, 19])}           | ${7}    | ${'two overlapping intervals, the time they share once'}
      ${minutes([14, 19], [12, 16])}           | ${7}    | ${'two overlapping intervals given in any order'}
      ${minutes([11, 19], [13, 15])}           | ${8}    | ${'an interval within another, the outer one alone'}
      ${minutes([12, 15], [15, 18])}           | ${6}    | ${'two intervals that touch, end to end'}
      ${minutes([5, 25], [12, 15])}            | ${10}   | ${'an interval over the whole period, the whole period'}
      ${minutes([12, 14], [13, 16], [15, 18])} | ${6}    | ${'three intervals in a chain, one span'}
    `('should count $covered minutes for $description', ({ intervals, covered }) => {
      expect(measureCoveredMs(intervals, PERIOD)).toBe(covered * ONE_MINUTE);
    });
  });

  describe('countCandle', () => {
    it.each`
      entryAt | candleMinute | low    | excursion | description
      ${1}    | ${1}         | ${80}  | ${20}     | ${'closed after the BUY filled, its low of 80: 20 %'}
      ${1}    | ${1}         | ${110} | ${0}      | ${'closed after the BUY filled, its low above the entry price: none'}
      ${2}    | ${1}         | ${80}  | ${0}      | ${'closed as the BUY filled: not held'}
      ${1}    | ${1}         | ${NaN} | ${0}      | ${'a low that is not a number: none'}
    `('should give an adverse excursion of $excursion % for a candle $description', ({ entryAt, candleMinute, low, excursion }) => {
      const counted = countCandle(openRoundTrip({ entryAt: entryAt * ONE_MINUTE }), { start: candleMinute * ONE_MINUTE, low });
      expect(counted.maxAdverseExcursion).toBe(excursion);
    });

    it('should note a candle that deepens the excursion: when it closed, and the deepest excursion before it', () => {
      const counted = countCandle(openRoundTrip({ maxAdverseExcursion: 5 }), { start: ONE_MINUTE, low: 80 });
      expect(counted.excursionDeepenings).toEqual([{ closeAt: 2 * ONE_MINUTE, previous: 5 }]);
    });

    it(`should keep the last ${LATE_FILL_CANDLES} candles that deepened the excursion`, () => {
      const roundTrip = openRoundTrip({ entryAt: 0 });
      // Each low lower than the one before: a deepening more than it keeps
      for (let minute = 0; minute <= LATE_FILL_CANDLES; minute++) countCandle(roundTrip, { start: minute * ONE_MINUTE, low: 99 - minute });
      expect(roundTrip.excursionDeepenings).toHaveLength(LATE_FILL_CANDLES);
    });
  });

  describe('measureAdverseExcursion', () => {
    // Two candles deepened its excursion: that of minute 1, which closed at minute 2, to 5 %, then that of minute 4, which closed at
    // minute 5, to 20 %
    const deepened = openRoundTrip({
      maxAdverseExcursion: 20,
      excursionDeepenings: [
        { closeAt: 2 * ONE_MINUTE, previous: 0 },
        { closeAt: 5 * ONE_MINUTE, previous: 5 },
      ],
    });

    it.each`
      exitAt | excursion | description
      ${1}   | ${0}      | ${'before either closed: both taken back'}
      ${3}   | ${5}      | ${'between their closes: the second taken back'}
      ${5}   | ${20}     | ${'as the second closed: both kept'}
    `(
      'should end with an adverse excursion of $excursion % when the SELL filled at minute $exitAt, $description',
      ({ exitAt, excursion }) => {
        expect(measureAdverseExcursion(deepened, exitAt * ONE_MINUTE)).toBe(excursion);
      },
    );
  });

  describe('logRoundtrip', () => {
    it.each`
      description                             | pnl          | currency  | expected
      ${'a P&L of a fraction of a BTC'}       | ${0.00042}   | ${'BTC'}  | ${'0.00042 BTC'}
      ${'a loss of a fraction of a BTC'}      | ${-0.00042}  | ${'BTC'}  | ${'-0.00042 BTC'}
      ${'a large P&L, its thousands grouped'} | ${1234.5678} | ${'USDT'} | ${'1,234.5678 USDT'}
    `('should print $description as $expected', ({ pnl, currency, expected }) => {
      logRoundtrip({ ...roundTrip, pnl }, currency, true, false);

      expect(printedRow()['P&L']).toBe(expected);
    });

    // A round trip that no portfolio read valued has no profit (NaN): written as it comes, it read as a figure. Its percentages are
    // rounded down to 2 decimals, as on Telegram (see PERCENT_ROUNDING)
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
      logRoundtrip({ ...roundTrip, ...fields }, 'BTC', true, false);

      expect(printedRow()[field]).toBe(expected);
    });

    // A run that watches several pairs prints the round trips of all of them: without their pair, they could not be told apart
    it('should name the pair of the round trip in a first row when asked to, as on a run that watches several pairs', () => {
      logRoundtrip(roundTrip, 'BTC', true, true);

      expect(Object.entries(printedRow())[0]).toEqual(['pair', 'ETH/BTC']);
    });

    it('should not name the pair when not asked to, as on a run that watches one pair', () => {
      logRoundtrip(roundTrip, 'BTC', true, false);

      expect(printedRow()).not.toHaveProperty('pair');
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
        logRoundtrip({ ...roundTrip, duration }, 'BTC', true, false);

        expect(printedRow().exposedDuration).toBe(expected);
      });
    });

    it('should not print a table when the console table is disabled', () => {
      logRoundtrip(roundTrip, 'BTC', false, true);

      expect(consoleTable).not.toHaveBeenCalled();
    });

    it.each`
      enableConsoleTable
      ${true}
      ${false}
    `('should log the round trip through info when enableConsoleTable is $enableConsoleTable', ({ enableConsoleTable }) => {
      logRoundtrip(roundTrip, 'BTC', enableConsoleTable, false);

      expect(info).toHaveBeenCalledWith('roundtrip analyzer', roundTrip);
    });
  });

  describe('logFinalize', () => {
    /** The row printed by the first console.table call: the report's */
    const reportRow = () => consoleTable.mock.calls[0]?.[0];

    it.each`
      description                                 | tradingReport                                  | field                    | expected
      ${'a start price of a fraction of a cent'}  | ${report}                                      | ${'startPrice'}          | ${'0.0000012 USDT'}
      ${'an end price of a fraction of a cent'}   | ${report}                                      | ${'endPrice'}            | ${'0.0000013 USDT'}
      ${'the benchmark asset of those prices'}    | ${report}                                      | ${'benchmark'}           | ${'PEPE'}
      ${'a start balance without decimals'}       | ${report}                                      | ${'startBalance'}        | ${'1,000 USDT'}
      ${'a final balance, its thousands grouped'} | ${report}                                      | ${'finalBalance'}        | ${'1,234.5678 USDT'}
      ${'a large yearly profit with its return'}  | ${report}                                      | ${'annualizedNetProfit'} | ${'85,617.247 USDT (116.8%)'}
      ${'a tiny yearly profit with its return'}   | ${{ ...report, annualizedNetProfit: 0.00042 }} | ${'annualizedNetProfit'} | ${'0.00042 USDT (116.8%)'}
      ${'an amount rounded to 8 decimals'}        | ${{ ...report, finalBalance: 0.123456789 }}    | ${'finalBalance'}        | ${'0.12345679 USDT'}
      ${'the win rate'}                           | ${report}                                      | ${'winRate'}             | ${'60%'}
      ${'no win rate without a round trip'}       | ${{ ...report, winRate: null }}                | ${'winRate'}             | ${'N/A'}
      ${'the net profit'}                         | ${report}                                      | ${'netProfit'}           | ${'234.5678 USDT'}
      ${'a net loss, its thousands grouped'}      | ${{ ...report, netProfit: -1234.5678 }}        | ${'netProfit'}           | ${'-1,234.5678 USDT'}
      ${'a net profit of a fraction of a cent'}   | ${{ ...report, netProfit: 0.00042 }}           | ${'netProfit'}           | ${'0.00042 USDT'}
      ${'the total return'}                       | ${report}                                      | ${'totalReturnPct'}      | ${'23.45%'}
    `('should print $description under $field', ({ tradingReport, field, expected }) => {
      logFinalize(tradingReport, 'USDT');

      expect(reportRow()[field]).toBe(expected);
    });

    // Named right after the prices it gives, as the PortfolioAnalyzer's table names its benchmark
    it('should print the benchmark row right after the end price', () => {
      logFinalize(report, 'USDT');

      const rows = Object.keys(reportRow());
      expect(rows[rows.indexOf('endPrice') + 1]).toBe('benchmark');
    });

    // As the CSV writes them (see PERCENT_ROUNDING, formatRatio): a win rate of 3.125 % read 3.13 % here, rounded half up, and 3.12 %
    // there; the downside deviation, a ratio there as the volatility is here, read 1.23 % for the 1.24 of the CSV
    it.each`
      field                    | fields                                     | expected
      ${'totalReturnPct'}      | ${{ totalReturnPct: -5.001 }}              | ${'-5.01%'}
      ${'totalReturnPct'}      | ${{ totalReturnPct: 3.125 }}               | ${'3.12%'}
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

      expect(reportRow()[field]).toBe(expected);
    });

    describe('on several pairs', () => {
      const severalPairs: TradingReport = {
        ...report,
        pairs: [
          pairSummary('BTC/USDT'),
          pairSummary('ETH/USDT', {
            roundTripCount: 0,
            winCount: 0,
            winRate: null,
            tradeCount: 1,
            pnl: -1234.5678,
            exposurePct: 3.125,
            maxAdverseExcursion: 1.005,
          }),
        ],
      };

      it('should print a second table, a row per pair, keyed by pair', () => {
        logFinalize(severalPairs, 'USDT');

        expect(consoleTable.mock.calls[1]).toEqual([
          {
            'BTC/USDT': {
              roundTrips: 5,
              wins: 3,
              winRate: '60%',
              tradeCount: 10,
              'P&L': '1.5 USDT',
              exposurePct: '50%',
              deepestMAE: '2.5%',
            },
            // Rounded as the report table rounds the same figures: half to even for the exposure, down for the excursion
            'ETH/USDT': {
              roundTrips: 0,
              wins: 0,
              winRate: 'N/A',
              tradeCount: 1,
              'P&L': '-1,234.5678 USDT',
              exposurePct: '3.12%',
              deepestMAE: '1%',
            },
          },
        ]);
      });

      it('should print it after the report table', () => {
        logFinalize(severalPairs, 'USDT');

        expect(reportRow().label).toBe('PROFIT REPORT');
      });
    });

    it.each`
      pairs                         | description
      ${[pairSummary('PEPE/USDT')]} | ${'one pair, which the report table gives already'}
      ${[]}                         | ${'none, in an empty report'}
    `('should print the report table alone for $description', ({ pairs }) => {
      logFinalize({ ...report, pairs }, 'USDT');

      expect(consoleTable).toHaveBeenCalledOnce();
    });

    // The report of a run stopped before its end covers a partial period, which the table alone showed as a complete one
    describe('for a run stopped before its end', () => {
      it('should print "Run interrupted, the report below covers a partial period. Reason: [STRATEGY] Max consecutive order errors reached (5)" once', () => {
        logFinalize({ ...report, interruption: '[STRATEGY] Max consecutive order errors reached (5)' }, 'USDT');

        expect(consoleLog.mock.calls).toEqual([
          ['Run interrupted, the report below covers a partial period. Reason: [STRATEGY] Max consecutive order errors reached (5)'],
        ]);
      });

      // An error without a message stopped the run all the same, as the status of the CSV row says
      it('should print "Run interrupted, the report below covers a partial period. Reason: " once for an error without a message', () => {
        logFinalize({ ...report, interruption: '' }, 'USDT');

        expect(consoleLog.mock.calls).toEqual([['Run interrupted, the report below covers a partial period. Reason: ']]);
      });

      it('should print that line above the table', () => {
        logFinalize({ ...report, interruption: '[STREAM] Missing candles in database' }, 'USDT');

        expect(consoleLog.mock.invocationCallOrder[0]).toBeLessThan(consoleTable.mock.invocationCallOrder[0]);
      });
    });

    it('should print no line beside the table of a run that reached its end', () => {
      logFinalize(report, 'USDT');

      expect(consoleLog).not.toHaveBeenCalled();
    });
  });

  describe('priceUncompletedFill', () => {
    // The last close is 90. The price a MARKET or a STICKY order carries is the one the strategy sized it from, 100: priced at it, the
    // part it filled at the market, before it was canceled or ended in error, made the cost and the P&L of its round trip off by that
    // amount times the gap.
    const FILLS = 'the prices of its fills, as the exchange reported them';
    it.each`
      order                                                        | type        | price        | fillPrice    | expected
      ${'a STICKY order sized at 100, its fills at 95'}            | ${'STICKY'} | ${100}       | ${95}        | ${{ price: 95, source: FILLS }}
      ${'a MARKET order sized at 100, its fills at 95'}            | ${'MARKET'} | ${100}       | ${95}        | ${{ price: 95, source: FILLS }}
      ${'a LIMIT order at 100, its fills at 99.5'}                 | ${'LIMIT'}  | ${100}       | ${99.5}      | ${{ price: 99.5, source: FILLS }}
      ${'a STICKY order sized at 100, no fill price reported'}     | ${'STICKY'} | ${100}       | ${undefined} | ${{ price: 90, source: 'the last close' }}
      ${'a MARKET order sized at 100, no fill price reported'}     | ${'MARKET'} | ${100}       | ${undefined} | ${{ price: 90, source: 'the last close' }}
      ${'a STICKY order without a price, no fill price'}           | ${'STICKY'} | ${undefined} | ${undefined} | ${{ price: 90, source: 'the last close' }}
      ${'a LIMIT order at 100, no fill price reported'}            | ${'LIMIT'}  | ${100}       | ${undefined} | ${{ price: 100, source: 'its limit price' }}
      ${'a LIMIT order without a price, at the market'}            | ${'LIMIT'}  | ${undefined} | ${undefined} | ${{ price: 90, source: 'the last close' }}
      ${'a LIMIT order at 100, a fill price that is not a number'} | ${'LIMIT'}  | ${100}       | ${NaN}       | ${{ price: 100, source: 'its limit price' }}
      ${'a STICKY order sized at 100, a fill price of 0'}          | ${'STICKY'} | ${100}       | ${0}         | ${{ price: 90, source: 'the last close' }}
    `('should price the fill of $order at $expected.price ($expected.source)', ({ type, price, fillPrice, expected }) => {
      expect(priceUncompletedFill({ type, price, fillPrice }, 90)).toEqual(expected);
    });
  });
});
