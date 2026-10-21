import { ONE_MINUTE } from '@constants/time.const';
import { warning } from '@services/logger';
import { useTimeZone } from '@utils/date/date.mock';
import { describe, expect, it, vi } from 'vitest';
import { PerformanceStatisticsInput } from './analyzer.types';
import { calculatePerformanceStatistics } from './analyzer.helper';

vi.mock('@services/logger', () => ({ warning: vi.fn() }));

const HOUR = 60 * ONE_MINUTE;
const DAY = 24 * HOUR;
// 2023 has 365 days: a day is 1/365 of a year in it
const START = Date.UTC(2023, 0, 1);
/** A gain of 1 % over an hour, the returns of which are a gain of 2 % and a loss of 1 %, with an exposure of half an hour */
const INPUT: PerformanceStatisticsInput = {
  periodStartAt: START,
  periodEndAt: START + HOUR,
  startEquity: 1000,
  endEquity: 1010,
  returns: [2, -1],
  marketReturnPct: 0.4,
  exposureMs: HOUR / 2,
  riskFreeReturn: 5,
};
/** The statistics of INPUT over a period of that many milliseconds */
const statisticsOver = (periodMs: number) =>
  calculatePerformanceStatistics({ ...INPUT, periodEndAt: START + periodMs, exposureMs: 0 }, 'portfolio analyzer');

describe('calculatePerformanceStatistics', () => {
  // The return of 1 % and the net profit of 10 are annualized over one horizon, the ratios too: the period, or a day for a shorter one,
  // 1/365 of a year in 2023. Annualized by sqrt(2 returns / years), the standard deviation of the returns, 1.5 around their mean of 0.5,
  // gives a Sharpe ratio of (yearly return - 5) / (1.5 * sqrt(2 / years)); their downside deviation, sqrt(1 / 2), a Sortino ratio of
  // (yearly return - 5) / sqrt(1 / years).
  describe('annualized over the period, or over a day for a shorter one', () => {
    it.each`
      period           | periodMs     | expected
      ${'of 0 ms'}     | ${0}         | ${365}
      ${'of an hour'}  | ${HOUR}      | ${365}
      ${'of a day'}    | ${DAY}       | ${365}
      ${'of two days'} | ${2 * DAY}   | ${182.5}
      ${'of a year'}   | ${365 * DAY} | ${1}
    `('should annualize the return of 1 % over a period $period to $expected %', ({ periodMs, expected }) => {
      expect(statisticsOver(periodMs).annualizedReturnPct).toBe(expected);
    });

    it.each`
      period           | periodMs     | expected
      ${'of 0 ms'}     | ${0}         | ${3650}
      ${'of an hour'}  | ${HOUR}      | ${3650}
      ${'of a day'}    | ${DAY}       | ${3650}
      ${'of two days'} | ${2 * DAY}   | ${1825}
      ${'of a year'}   | ${365 * DAY} | ${10}
    `('should annualize the net profit of 10 over a period $period to $expected', ({ periodMs, expected }) => {
      expect(statisticsOver(periodMs).annualizedNetProfit).toBe(expected);
    });

    it.each`
      period           | periodMs     | ratio                    | expected
      ${'of 0 ms'}     | ${0}         | ${'240 / sqrt(730)'}     | ${240 / Math.sqrt(730)}
      ${'of an hour'}  | ${HOUR}      | ${'240 / sqrt(730)'}     | ${240 / Math.sqrt(730)}
      ${'of a day'}    | ${DAY}       | ${'240 / sqrt(730)'}     | ${240 / Math.sqrt(730)}
      ${'of two days'} | ${2 * DAY}   | ${'355 / 3 / sqrt(365)'} | ${355 / 3 / Math.sqrt(365)}
      ${'of a year'}   | ${365 * DAY} | ${'-8 / 3 / sqrt(2)'}    | ${-8 / 3 / Math.SQRT2}
    `('should annualize the Sharpe ratio over a period $period to $ratio', ({ periodMs, expected }) => {
      expect(statisticsOver(periodMs).sharpeRatio).toBeCloseTo(expected, 12);
    });

    it.each`
      period           | periodMs     | ratio                    | expected
      ${'of 0 ms'}     | ${0}         | ${'360 / sqrt(365)'}     | ${360 / Math.sqrt(365)}
      ${'of an hour'}  | ${HOUR}      | ${'360 / sqrt(365)'}     | ${360 / Math.sqrt(365)}
      ${'of a day'}    | ${DAY}       | ${'360 / sqrt(365)'}     | ${360 / Math.sqrt(365)}
      ${'of two days'} | ${2 * DAY}   | ${'177.5 / sqrt(182.5)'} | ${177.5 / Math.sqrt(182.5)}
      ${'of a year'}   | ${365 * DAY} | ${'-4'}                  | ${-4}
    `('should annualize the Sortino ratio over a period $period to $ratio', ({ periodMs, expected }) => {
      expect(statisticsOver(periodMs).sortinoRatio).toBeCloseTo(expected, 12);
    });
  });

  it.each`
    period           | periodMs   | warnings
    ${'of 0 ms'}     | ${0}       | ${1}
    ${'of an hour'}  | ${HOUR}    | ${1}
    ${'of a day'}    | ${DAY}     | ${0}
    ${'of two days'} | ${2 * DAY} | ${0}
  `('should warn $warnings time(s) that the figures are annualized over a day with a period $period', ({ periodMs, warnings }) => {
    statisticsOver(periodMs);
    expect(warning).toHaveBeenCalledTimes(warnings);
  });

  it('should warn with the tag of the analyzer that a period shorter than a day is annualized over a day', () => {
    calculatePerformanceStatistics(INPUT, 'roundtrip analyzer');
    expect(warning).toHaveBeenCalledWith('roundtrip analyzer', expect.stringContaining('Period shorter than a day'));
  });

  it.each`
    field                  | expected
    ${'periodStartAt'}     | ${START}
    ${'periodEndAt'}       | ${START + HOUR}
    ${'netProfit'}         | ${10}
    ${'totalReturnPct'}    | ${1}
    ${'marketReturnPct'}   | ${0.4}
    ${'alpha'}             | ${0.6}
    ${'exposurePct'}       | ${50}
    ${'downsideDeviation'} | ${Math.SQRT1_2}
  `('should report $field $expected', ({ field, expected }) => {
    expect(calculatePerformanceStatistics(INPUT, 'portfolio analyzer')[field as 'netProfit']).toBe(expected);
  });

  // The amounts are worked out in decimal, as the equities are valued: in binary, the net profit from 1000 to 1000.3 was
  // 0.2999999999999545, and that profit over the 3 years from 2023 to 2026 0.09999999999998485 a year
  it.each`
    field                    | expected
    ${'netProfit'}           | ${0.3}
    ${'annualizedNetProfit'} | ${0.1}
  `('should report $field $expected from 1000 to 1000.3 over 3 years', ({ field, expected }) => {
    const input = { ...INPUT, endEquity: 1000.3, periodEndAt: Date.UTC(2026, 0, 1) };
    expect(calculatePerformanceStatistics(input, 'portfolio analyzer')[field as 'netProfit']).toBe(expected);
  });

  // Worked out from the total return, rounded to 15 significant digits, 40 on 300,000 over a day of 2024 was annualized to
  // ±4.87999999999999 %: the reporters, rounding down, wrote the gain 4.87 %
  it.each`
    endEquity | change   | expected
    ${300040} | ${'+40'} | ${4.88}
    ${299960} | ${'-40'} | ${-4.88}
  `('should annualize a change of $change on 300000 over a day of 2024 to $expected %', ({ endEquity, expected }) => {
    const input = { ...INPUT, periodStartAt: Date.UTC(2024, 0, 1), periodEndAt: Date.UTC(2024, 0, 2), startEquity: 300000, endEquity };
    expect(calculatePerformanceStatistics(input, 'portfolio analyzer').annualizedReturnPct).toBe(expected);
  });

  it('should report an exposure of 0 over a period of 0 ms', () => {
    expect(statisticsOver(0).exposurePct).toBe(0);
  });

  it.each`
    returns            | volatility | description
    ${[]}              | ${0}       | ${'no return'}
    ${[2]}             | ${0}       | ${'a single return'}
    ${[2, -1]}         | ${1.5}     | ${'returns of 2 and -1'}
    ${[0.1, 0.1, 0.1]} | ${0}       | ${'returns all of 0.1, whose standard deviation is the noise of their mean, 1.4e-17'}
    ${[2, NaN]}        | ${0}       | ${'a return that is not a number'}
  `('should report a volatility of $volatility with $description', ({ returns, volatility }) => {
    expect(calculatePerformanceStatistics({ ...INPUT, returns }, 'portfolio analyzer').volatility).toBe(volatility);
  });

  // Counted on the UTC calendar, the duration is the same on every host. Counted on the host's, a period across a change of daylight
  // saving time came out an hour off on a host in Paris or New York: from 2024-10-01 to 2024-11-01, "30 days 23 hours" in Paris and
  // "1 month 1 day" in New York. The last two periods end at a UTC wall-clock time that Paris, then New York, skip at their spring
  // change: through @date-fns/tz's TZDate for 'UTC', each read "1 day -1 hours" on a host there.
  describe.each`
    timeZone
    ${'UTC'}
    ${'Europe/Paris'}
    ${'America/New_York'}
  `('on a host in $timeZone', ({ timeZone }) => {
    useTimeZone(timeZone);

    it.each`
      start                     | end                       | expected
      ${'2023-01-01T00:00:00Z'} | ${'2023-01-01T01:00:00Z'} | ${'1 hour'}
      ${'2024-01-01T00:00:00Z'} | ${'2024-07-01T00:00:00Z'} | ${'6 months'}
      ${'2024-10-01T00:00:00Z'} | ${'2024-11-01T00:00:00Z'} | ${'1 month'}
      ${'2024-03-01T00:00:00Z'} | ${'2024-04-01T00:00:00Z'} | ${'1 month'}
      ${'2024-03-10T00:00:00Z'} | ${'2024-03-11T00:00:00Z'} | ${'1 day'}
      ${'2024-03-31T00:00:00Z'} | ${'2024-04-01T00:00:00Z'} | ${'1 day'}
      ${'2024-10-27T00:00:00Z'} | ${'2024-10-28T00:00:00Z'} | ${'1 day'}
      ${'2024-11-03T00:00:00Z'} | ${'2024-11-04T00:00:00Z'} | ${'1 day'}
      ${'2023-01-01T00:00:00Z'} | ${'2025-01-01T00:00:00Z'} | ${'2 years'}
      ${'2023-03-25T02:30:00Z'} | ${'2023-03-26T02:30:00Z'} | ${'1 day'}
      ${'2023-03-11T02:00:00Z'} | ${'2023-03-12T02:00:00Z'} | ${'1 day'}
    `('should report a duration of $expected from $start to $end', ({ start, end, expected }) => {
      const input = { ...INPUT, periodStartAt: Date.parse(start), periodEndAt: Date.parse(end) };
      expect(calculatePerformanceStatistics(input, 'portfolio analyzer').formattedDuration).toBe(expected);
    });
  });
});
