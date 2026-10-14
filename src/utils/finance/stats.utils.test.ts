import { useTimeZone } from '@utils/date/date.mock';
import { describe, expect, it } from 'vitest';
import {
  calculateAlpha,
  calculateAnnualizedReturnPct,
  calculateDownsideDeviation,
  calculateElapsedYears,
  calculateExposurePct,
  calculateLongestDrawdownDuration,
  calculateMarketReturnPct,
  calculateMaxDrawdown,
  calculateReturns,
  calculateSharpeRatio,
  calculateSortinoRatio,
  calculateTotalReturnPct,
  calculateWinRate,
  extractTopMAEs,
} from './stats.utils';

describe('calculateElapsedYears', () => {
  // Counted in UTC from an anniversary of the start to the next, the same on every host. Counted in local time, as date-fns counted
  // them, the rows about Paris or New York came out an hour or a day off on a host there, and two of the rows from a Feb 29 were off on
  // every host. The values are exact: a year of 365 or 365.25 days fails them.
  describe.each`
    timeZone
    ${'UTC'}
    ${'Europe/Paris'}
    ${'America/New_York'}
  `('on a host in $timeZone', ({ timeZone }) => {
    useTimeZone(timeZone);

    it.each`
      description                                                              | start                     | end                       | years                  | expected
      ${'the same instant'}                                                    | ${'2024-01-01T00:00:00Z'} | ${'2024-01-01T00:00:00Z'} | ${'0'}                 | ${0}
      ${'a day of 2024, a leap year'}                                          | ${'2024-01-01T00:00:00Z'} | ${'2024-01-02T00:00:00Z'} | ${'1/366'}             | ${1 / 366}
      ${'half of 2023'}                                                        | ${'2023-01-01T00:00:00Z'} | ${'2023-07-02T00:00:00Z'} | ${'182/365'}           | ${182 / 365}
      ${'half of 2024, a leap year'}                                           | ${'2024-01-01T00:00:00Z'} | ${'2024-07-01T00:00:00Z'} | ${'182/366'}           | ${182 / 366}
      ${'2024, a leap year'}                                                   | ${'2024-01-01T00:00:00Z'} | ${'2025-01-01T00:00:00Z'} | ${'1'}                 | ${1}
      ${'two years'}                                                           | ${'2023-01-01T00:00:00Z'} | ${'2025-01-01T00:00:00Z'} | ${'2'}                 | ${2}
      ${'a year and a half'}                                                   | ${'2024-01-01T00:00:00Z'} | ${'2025-07-01T00:00:00Z'} | ${'1 + 181/365'}       | ${1 + 181 / 365}
      ${'a year from summer time to winter time in Paris'}                     | ${'2018-03-26T00:00:00Z'} | ${'2019-03-26T00:00:00Z'} | ${'1'}                 | ${1}
      ${'a year from winter time to summer time in New York'}                  | ${'2024-03-10T06:30:00Z'} | ${'2025-03-10T06:30:00Z'} | ${'1'}                 | ${1}
      ${'a year from Feb 28, 23:00, already Feb 29 in Paris'}                  | ${'2024-02-28T23:00:00Z'} | ${'2025-02-28T23:00:00Z'} | ${'1'}                 | ${1}
      ${'a day from Feb 28, 23:30, already Feb 29 in Paris'}                   | ${'2024-02-28T23:30:00Z'} | ${'2024-02-29T23:30:00Z'} | ${'1/366'}             | ${1 / 366}
      ${'half a year from Mar 1, still Feb 28 in New York, in a 366-day year'} | ${'2019-03-01T00:00:00Z'} | ${'2019-09-01T00:00:00Z'} | ${'184/366'}           | ${184 / 366}
      ${'Mar 1, still Feb 28 in New York, to the next Feb 29'}                 | ${'2023-03-01T00:00:00Z'} | ${'2024-02-29T00:00:00Z'} | ${'365/366'}           | ${365 / 366}
      ${'a year from a Feb 29, to the Feb 28 after'}                           | ${'2024-02-29T00:00:00Z'} | ${'2025-02-28T00:00:00Z'} | ${'1'}                 | ${1}
      ${'a Feb 29 to the Mar 1 a year after'}                                  | ${'2024-02-29T00:00:00Z'} | ${'2025-03-01T00:00:00Z'} | ${'1 + 1/365'}         | ${1 + 1 / 365}
      ${'a Feb 29 to Mar 1 three years on, in a 366-day year'}                 | ${'2024-02-29T00:00:00Z'} | ${'2027-03-01T00:00:00Z'} | ${'3 + 1/366'}         | ${3 + 1 / 366}
      ${'a Feb 29 to a minute before the next'}                                | ${'2024-02-29T00:00:00Z'} | ${'2028-02-28T23:59:00Z'} | ${'3 + 527039/527040'} | ${3 + 527039 / 527040}
      ${'a Feb 29 to the next'}                                                | ${'2024-02-29T00:00:00Z'} | ${'2028-02-29T00:00:00Z'} | ${'4'}                 | ${4}
    `('should count $years years from $start to $end: $description', ({ start, end, expected }) => {
      expect(calculateElapsedYears(Date.parse(start), Date.parse(end))).toBe(expected);
    });
  });

  it('should throw error when endDate is before startDate', () => {
    expect(() => calculateElapsedYears(Date.UTC(2025, 0, 1), Date.UTC(2024, 0, 1))).toThrow(
      'endDate must be greater than or equal to startDate',
    );
  });
});

describe('calculateTotalReturnPct', () => {
  // The percentages here and below are decimals: the reporters round them to 2 decimals, most of them down, and the binary value a
  // description gives came out an ulp or so off its decimal, a hundredth too low once floored when below it
  it.each`
    description                                      | currentEquity | startEquity | expected
    ${'100% gain'}                                   | ${2000}       | ${1000}     | ${100}
    ${'50% gain'}                                    | ${1500}       | ${1000}     | ${50}
    ${'no change'}                                   | ${1000}       | ${1000}     | ${0}
    ${'25% loss'}                                    | ${750}        | ${1000}     | ${-25}
    ${'50% loss'}                                    | ${500}        | ${1000}     | ${-50}
    ${'total loss'}                                  | ${0}          | ${1000}     | ${-100}
    ${'300% gain'}                                   | ${4000}       | ${1000}     | ${300}
    ${'small start equity'}                          | ${0.002}      | ${0.001}    | ${100}
    ${'0.02% gain, 0.01999999999999602 in binary'}   | ${1000.2}     | ${1000}     | ${0.02}
    ${'0.01% loss, -0.010000000000005116 in binary'} | ${999.9}      | ${1000}     | ${-0.01}
    ${'0.3% loss, -0.29999999999999716 in binary'}   | ${997}        | ${1000}     | ${-0.3}
  `('should return $expected for $description', ({ currentEquity, startEquity, expected }) => {
    expect(calculateTotalReturnPct(currentEquity, startEquity)).toBe(expected);
  });

  it('should throw error when startEquity is zero', () => {
    expect(() => calculateTotalReturnPct(1000, 0)).toThrow('startEquity must be greater than zero');
  });

  it('should throw error when startEquity is negative', () => {
    expect(() => calculateTotalReturnPct(1000, -100)).toThrow('startEquity must be greater than zero');
  });
});

describe('calculateAnnualizedReturnPct', () => {
  it.each`
    description                                           | totalReturnPct | elapsedYears | expected
    ${'1 year period'}                                    | ${50}          | ${1}         | ${50}
    ${'2 year period'}                                    | ${100}         | ${2}         | ${50}
    ${'half year period'}                                 | ${25}          | ${0.5}       | ${50}
    ${'negative return'}                                  | ${-30}         | ${2}         | ${-15}
    ${'very short period'}                                | ${10}          | ${0.1}       | ${100}
    ${'long period'}                                      | ${100}         | ${10}        | ${10}
    ${'0.3% over 3 years, 0.09999999999999999 in binary'} | ${0.3}         | ${3}         | ${0.1}
  `('should return $expected for $description', ({ totalReturnPct, elapsedYears, expected }) => {
    expect(calculateAnnualizedReturnPct(totalReturnPct, elapsedYears)).toBe(expected);
  });

  it('should throw error when elapsedYears is zero', () => {
    expect(() => calculateAnnualizedReturnPct(50, 0)).toThrow('elapsedYears must be greater than zero');
  });

  it('should throw error when elapsedYears is negative', () => {
    expect(() => calculateAnnualizedReturnPct(50, -1)).toThrow('elapsedYears must be greater than zero');
  });
});

describe('calculateMarketReturnPct', () => {
  it.each`
    description                                                        | endPrice  | startPrice | expected
    ${'100% gain'}                                                     | ${200}    | ${100}     | ${100}
    ${'50% gain'}                                                      | ${150}    | ${100}     | ${50}
    ${'no change'}                                                     | ${100}    | ${100}     | ${0}
    ${'50% loss'}                                                      | ${50}     | ${100}     | ${-50}
    ${'total loss'}                                                    | ${0}      | ${100}     | ${-100}
    ${'small prices'}                                                  | ${0.002}  | ${0.001}   | ${100}
    ${'large prices'}                                                  | ${60000}  | ${30000}   | ${100}
    ${'a stablecoin from 1 to 1.0001, 0.009999999999998899 in binary'} | ${1.0001} | ${1}       | ${0.01}
    ${'a stablecoin from 1 to 0.999, -0.10000000000000009 in binary'}  | ${0.999}  | ${1}       | ${-0.1}
    ${'7% loss, -7.000000000000001 in binary'}                         | ${93}     | ${100}     | ${-7}
  `('should return $expected for $description', ({ endPrice, startPrice, expected }) => {
    expect(calculateMarketReturnPct(endPrice, startPrice)).toBe(expected);
  });

  it('should throw error when startPrice is zero', () => {
    expect(() => calculateMarketReturnPct(100, 0)).toThrow('startPrice must be greater than zero');
  });

  it('should throw error when startPrice is negative', () => {
    expect(() => calculateMarketReturnPct(100, -50)).toThrow('startPrice must be greater than zero');
  });
});

describe('calculateAlpha', () => {
  it.each`
    description                                               | totalReturnPct       | marketReturnPct      | expected
    ${'positive alpha'}                                       | ${50}                | ${30}                | ${20}
    ${'negative alpha'}                                       | ${20}                | ${50}                | ${-30}
    ${'zero alpha'}                                           | ${50}                | ${50}                | ${0}
    ${'large alpha'}                                          | ${100}               | ${-20}               | ${120}
    ${'both negative'}                                        | ${-10}               | ${-30}               | ${20}
    ${'strategy at loss'}                                     | ${-20}               | ${10}                | ${-30}
    ${'0.3 over 0.1, 0.19999999999999998 in binary'}          | ${0.3}               | ${0.1}               | ${0.2}
    ${'returns 1.3e-14 apart, the noise of their arithmetic'} | ${5.156953387307055} | ${5.156953387307069} | ${0}
    ${'a millionth of a point, a real difference'}            | ${100.000001}        | ${100}               | ${0.000001}
  `('should return $expected for $description', ({ totalReturnPct, marketReturnPct, expected }) => {
    expect(calculateAlpha(totalReturnPct, marketReturnPct)).toBe(expected);
  });

  // The return of a portfolio holding the benchmark asset alone, worked out from its equities, is the market return in exact arithmetic
  it.each`
    btc        | startPrice  | endPrice    | startEquity      | endEquity        | returns
    ${0.22368} | ${79290.42} | ${83379.39} | ${17735.6811456} | ${18650.3019552} | ${'1.3e-14 apart in binary'}
    ${0.02}    | ${66428.59} | ${32158.72} | ${1328.5718}     | ${643.1744}      | ${'1e-13 apart to 15 significant digits'}
  `(
    'should return an alpha of 0 for $btc BTC held from $startPrice to $endPrice, returns $returns',
    ({ startPrice, endPrice, startEquity, endEquity }) => {
      const totalReturnPct = calculateTotalReturnPct(endEquity, startEquity);
      expect(calculateAlpha(totalReturnPct, calculateMarketReturnPct(endPrice, startPrice))).toBe(0);
    },
  );
});

describe('calculateExposurePct', () => {
  it.each`
    description                                             | exposureMs  | totalMs     | expected
    ${'100% exposure'}                                      | ${86400000} | ${86400000} | ${100}
    ${'50% exposure'}                                       | ${43200000} | ${86400000} | ${50}
    ${'0% exposure'}                                        | ${0}        | ${86400000} | ${0}
    ${'25% exposure'}                                       | ${21600000} | ${86400000} | ${25}
    ${'minimal exposure, 0.00009999999999999999 in binary'} | ${1}        | ${1000000}  | ${0.0001}
    ${'30.24 s of a day, 0.034999999999999996 in binary'}   | ${30240}    | ${86400000} | ${0.035}
  `('should return $expected for $description', ({ exposureMs, totalMs, expected }) => {
    expect(calculateExposurePct(exposureMs, totalMs)).toBe(expected);
  });

  it('should throw error when totalMs is zero', () => {
    expect(() => calculateExposurePct(1000, 0)).toThrow('totalMs must be greater than zero');
  });

  it('should throw error when totalMs is negative', () => {
    expect(() => calculateExposurePct(1000, -1000)).toThrow('totalMs must be greater than zero');
  });
});

describe('calculateWinRate', () => {
  // toBe, not toBeCloseTo, which reads null as 0: a null win rate for round trips that all lose, written N/A in the reports, passed it
  it.each`
    description                                       | winningTrades | totalTrades | expected
    ${'all wins'}                                     | ${10}         | ${10}       | ${100}
    ${'all losses'}                                   | ${0}          | ${10}       | ${0}
    ${'50% win rate'}                                 | ${5}          | ${10}       | ${50}
    ${'75% win rate'}                                 | ${75}         | ${100}      | ${75}
    ${'29 wins in 100, 28.999999999999996 in binary'} | ${29}         | ${100}      | ${29}
    ${'a win in 3, to 15 significant digits'}         | ${1}          | ${3}        | ${33.3333333333333}
    ${'single win'}                                   | ${1}          | ${1}        | ${100}
    ${'single loss'}                                  | ${0}          | ${1}        | ${0}
    ${'no trades'}                                    | ${0}          | ${0}        | ${null}
    ${'a negative number of trades'}                  | ${5}          | ${-1}       | ${null}
  `('should return $expected for $description', ({ winningTrades, totalTrades, expected }) => {
    expect(calculateWinRate(winningTrades, totalTrades)).toBe(expected);
  });
});

describe('calculateDownsideDeviation', () => {
  it('should return 0 for empty array', () => {
    expect(calculateDownsideDeviation([])).toBe(0);
  });

  it('should return 0 when all profits are positive', () => {
    expect(calculateDownsideDeviation([10, 20, 30, 5])).toBe(0);
  });

  it('should return 0 when all profits are zero', () => {
    expect(calculateDownsideDeviation([0, 0, 0])).toBe(0);
  });

  it('should calculate correctly for all negative profits', () => {
    // All losses: [-10, -20, -30]
    // Squared: [100, 400, 900]
    // Sum: 1400, divided by 3 = 466.67, sqrt = 21.60
    const profits = [-10, -20, -30];
    expect(calculateDownsideDeviation(profits)).toBeCloseTo(21.602, 2);
  });

  it('should calculate correctly for mixed profits', () => {
    // Losses only: [-10, -5]
    // Squared: [100, 25]
    // Sum: 125, divided by 4 (total count) = 31.25, sqrt = 5.59
    const profits = [10, -10, 15, -5];
    expect(calculateDownsideDeviation(profits)).toBeCloseTo(5.59, 2);
  });

  it('should handle single negative profit', () => {
    // Squared: 25, divided by 1 = 25, sqrt = 5
    expect(calculateDownsideDeviation([-5])).toBe(5);
  });

  it('should handle single positive profit', () => {
    expect(calculateDownsideDeviation([5])).toBe(0);
  });
});

describe('extractTopMAEs', () => {
  it('should return empty array for empty input', () => {
    expect(extractTopMAEs([])).toEqual([]);
  });

  it('should return all MAEs when fewer than limit', () => {
    const maes = [5, 10, 3];
    expect(extractTopMAEs(maes)).toEqual([10, 5, 3]);
  });

  it('should return top 10 MAEs by default (sorted descending)', () => {
    const maes = [1, 12, 5, 8, 15, 3, 9, 2, 11, 7, 4, 6, 14, 13, 10];
    expect(extractTopMAEs(maes)).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7, 6]);
  });

  it('should respect custom limit', () => {
    const maes = [10, 20, 5, 15, 8];
    expect(extractTopMAEs(maes, 3)).toEqual([20, 15, 10]);
  });

  it('should filter out negative values', () => {
    const maes = [10, -5, 20, -10, 15];
    expect(extractTopMAEs(maes)).toEqual([20, 15, 10]);
  });

  it('should filter out NaN values', () => {
    const maes = [10, NaN, 20, NaN, 15];
    expect(extractTopMAEs(maes)).toEqual([20, 15, 10]);
  });

  it('should filter out Infinity values', () => {
    const maes = [10, Infinity, 20, -Infinity, 15];
    expect(extractTopMAEs(maes)).toEqual([20, 15, 10]);
  });

  it('should include zero values', () => {
    const maes = [5, 0, 10, 0];
    expect(extractTopMAEs(maes)).toEqual([10, 5, 0, 0]);
  });

  it('should not mutate the input array', () => {
    const maes = [5, 10, 3];
    const copy = [...maes];
    extractTopMAEs(maes);
    expect(maes).toEqual(copy);
  });
});

describe('calculateSharpeRatio', () => {
  it.each`
    description                                  | returns         | yearlyProfit | riskFreeReturn | elapsedYears | expected
    ${'return 0 for empty returns array'}        | ${[]}           | ${10}        | ${1}           | ${1}         | ${0}
    ${'return 0 for zero elapsed years'}         | ${[1, 2, 3]}    | ${10}        | ${1}           | ${0}         | ${0}
    ${'return 0 for negative elapsed years'}     | ${[1, 2, 3]}    | ${10}        | ${1}           | ${-1}        | ${0}
    ${'return 0 when all returns are identical'} | ${[5, 5, 5, 5]} | ${10}        | ${1}           | ${1}         | ${0}
  `('should $description', ({ returns, yearlyProfit, riskFreeReturn, elapsedYears, expected }) => {
    expect(calculateSharpeRatio({ returns, yearlyProfit, riskFreeReturn, elapsedYears })).toBe(expected);
  });

  it.each`
    description                                           | returns                     | yearlyProfit | riskFreeReturn | elapsedYears | comparison
    ${'calculate positive ratio for profitable strategy'} | ${[2, -1, 3, -0.5, 2.5, 1]} | ${15}        | ${2}           | ${1}         | ${'positive'}
    ${'calculate negative ratio when below risk-free'}    | ${[2, -1, 3, -0.5, 2.5, 1]} | ${0.5}       | ${2}           | ${1}         | ${'negative'}
  `('should $description', ({ returns, yearlyProfit, riskFreeReturn, elapsedYears, comparison }) => {
    const result = calculateSharpeRatio({ returns, yearlyProfit, riskFreeReturn, elapsedYears });
    if (comparison === 'positive') expect(result).toBeGreaterThan(0);
    else expect(result).toBeLessThan(0);
  });

  it('should scale correctly with elapsed years', () => {
    const params = {
      returns: [2, -1, 3, -0.5, 2.5, 1, 0.5, -0.3, 1.5, 2, -1, 0.8],
      yearlyProfit: 10,
      riskFreeReturn: 1,
      elapsedYears: 1,
    };
    const oneYear = calculateSharpeRatio(params);
    const twoYears = calculateSharpeRatio({ ...params, elapsedYears: 2 });
    // Same number of observations over 2 years means fewer observations per year,
    // so annualized volatility is lower, and sharpe should be higher
    expect(twoYears).toBeGreaterThan(oneYear);
  });
});

describe('calculateSortinoRatio', () => {
  // Downside deviation over the n returns, gains counting as 0: sqrt(sum of squared losses / n). Annualized by sqrt(n / years),
  // it simplifies to sqrt(sum of squared losses / years). All rows but the last earn 16 - 1 = 15 points over the risk-free return:
  // - single loss, [3, -4, 5] over 1 year: sqrt(16 / 1) = 4, 15 / 4 = 3.75
  // - equal losses, [-2, -2, -2, 5, 5] over 3 years: sqrt((4 + 4 + 4) / 3) = 2, 15 / 2 = 7.5
  // - losses of 1 and 3, [5, -1, -3] over 1 year: sqrt(1 + 9) = 3.162278, 15 / 3.162278 = 4.74342 (rounded)
  // - losses of 11 and 13, [5, -11, -13] over 1 year: sqrt(121 + 169) = 17.029386, 15 / 17.029386 = 0.88083 (rounded)
  // - small losses among large gains, [5, -4, 12, -3] over 1 year: sqrt(16 + 9) = 5, 15 / 5 = 3. Its Sharpe ratio is only
  //   15 / 13 = 1.15: mean 2.5, annualized standard deviation sqrt(6.25 + 42.25 + 90.25 + 30.25) = sqrt(169) = 13
  // - below the risk-free return, [3, -4, 5] over 1 year earning 1 - 3 = -2: -2 / 4 = -0.5
  // The stdev of the losses around their own mean, used before, gave 0 for the first two rows, 8.660254 for both of the next
  // two and 15 for the small losses. Values have at most 5 decimals and toBeCloseTo(_, 4) allows a difference below 0.00005.
  it.each`
    description                                   | returns               | yearlyProfit | riskFreeReturn | elapsedYears | expected
    ${'return 0 for an empty returns array'}      | ${[]}                 | ${16}        | ${1}           | ${1}         | ${0}
    ${'return 0 for zero elapsed years'}          | ${[5, -1, -3]}        | ${16}        | ${1}           | ${0}         | ${0}
    ${'return 0 for negative elapsed years'}      | ${[5, -1, -3]}        | ${16}        | ${1}           | ${-1}        | ${0}
    ${'return 0 when no return is a loss'}        | ${[1, 0, 3]}          | ${16}        | ${1}           | ${1}         | ${0}
    ${'count a single loss as downside risk'}     | ${[3, -4, 5]}         | ${16}        | ${1}           | ${1}         | ${3.75}
    ${'count equal losses as downside risk'}      | ${[-2, -2, -2, 5, 5]} | ${16}        | ${1}           | ${3}         | ${7.5}
    ${'weigh losses of 1 and 3 by their size'}    | ${[5, -1, -3]}        | ${16}        | ${1}           | ${1}         | ${4.74342}
    ${'weigh losses of 11 and 13 by their size'}  | ${[5, -11, -13]}      | ${16}        | ${1}           | ${1}         | ${0.88083}
    ${'not count the gains as risk'}              | ${[5, -4, 12, -3]}    | ${16}        | ${1}           | ${1}         | ${3}
    ${'turn negative below the risk-free return'} | ${[3, -4, 5]}         | ${1}         | ${3}           | ${1}         | ${-0.5}
  `('should $description', ({ returns, yearlyProfit, riskFreeReturn, elapsedYears, expected }) => {
    expect(calculateSortinoRatio({ returns, yearlyProfit, riskFreeReturn, elapsedYears })).toBeCloseTo(expected, 4);
  });

  it('should be higher than the sharpe ratio when the losses are small relative to the overall spread', () => {
    // 3 against 15 / 13, see the small losses among large gains above
    const params = { returns: [5, -4, 12, -3], yearlyProfit: 16, riskFreeReturn: 1, elapsedYears: 1 };
    expect(calculateSortinoRatio(params)).toBeGreaterThan(calculateSharpeRatio(params));
  });
});

describe('calculateMaxDrawdown', () => {
  it.each`
    description                                                   | balances                                | initialBalance | expected
    ${'no balance'}                                               | ${[]}                                   | ${1000}        | ${0}
    ${'an initial balance of 0'}                                  | ${[100, 200]}                           | ${0}           | ${0}
    ${'a negative initial balance'}                               | ${[100, 200]}                           | ${-100}        | ${0}
    ${'balances that only increase'}                              | ${[1100, 1200, 1300]}                   | ${1000}        | ${0}
    ${'balances that stay constant'}                              | ${[1000, 1000, 1000]}                   | ${1000}        | ${0}
    ${'a drawdown from the initial balance'}                      | ${[900]}                                | ${1000}        | ${10}
    ${'a drawdown from a new peak'}                               | ${[1100, 990]}                          | ${1000}        | ${10}
    ${'the largest of several declines'}                          | ${[1100, 1000, 1200, 900]}              | ${1000}        | ${25}
    ${'a 100% drawdown'}                                          | ${[1000, 0]}                            | ${1000}        | ${100}
    ${'small fractional changes, to 15 significant digits'}       | ${[100.5, 100.0, 100.2]}                | ${100}         | ${0.497512437810945}
    ${'a peak of 1500 through ups and downs, a third of it lost'} | ${[1000, 1200, 1500, 1200, 1000, 1300]} | ${1000}        | ${33.3333333333333}
    ${'999.7 from 1000, 0.029999999999995454 in binary'}          | ${[999.7]}                              | ${1000}        | ${0.03}
    ${'a NaN balance, which is skipped'}                          | ${[1000, NaN, 900]}                     | ${1000}        | ${10}
  `('should return $expected for $description', ({ balances, initialBalance, expected }) => {
    expect(calculateMaxDrawdown(balances, initialBalance)).toBe(expected);
  });

  it('should not mutate input array', () => {
    const balances = [1100, 1000, 1200];
    const copy = [...balances];
    calculateMaxDrawdown(balances, 1000);
    expect(balances).toEqual(copy);
  });
});

describe('calculateLongestDrawdownDuration', () => {
  it.each`
    description                                     | samples                                                                                                                                                                      | initialBalance | expected
    ${'return 0 for empty samples'}                 | ${[]}                                                                                                                                                                        | ${1000}        | ${0}
    ${'return 0 when initialBalance is 0'}          | ${[{ date: 1000, totalValue: 900 }]}                                                                                                                                         | ${0}           | ${0}
    ${'return 0 when initialBalance is negative'}   | ${[{ date: 1000, totalValue: 900 }]}                                                                                                                                         | ${-100}        | ${0}
    ${'return 0 if balance never drops below peak'} | ${[{ date: 1000, totalValue: 1000 }, { date: 2000, totalValue: 1100 }]}                                                                                                      | ${1000}        | ${0}
    ${'calculate duration of single drawdown'}      | ${[{ date: 1000, totalValue: 1000 }, { date: 2000, totalValue: 900 }, { date: 3000, totalValue: 1000 }]}                                                                     | ${1000}        | ${2000}
    ${'find longest among multiple drawdowns'}      | ${[{ date: 1000, totalValue: 1000 }, { date: 2000, totalValue: 900 }, { date: 3000, totalValue: 1000 }, { date: 4000, totalValue: 800 }, { date: 10000, totalValue: 1000 }]} | ${1000}        | ${7000}
    ${'handle ongoing drawdown at end'}             | ${[{ date: 1000, totalValue: 1000 }, { date: 2000, totalValue: 900 }]}                                                                                                       | ${1000}        | ${1000}
  `('should $description', ({ samples, initialBalance, expected }) => {
    expect(calculateLongestDrawdownDuration(samples, initialBalance)).toBe(expected);
  });

  it('should track recovery to exact peak value', () => {
    // Drop from 1000 to 800, then recover to exactly 1000 at date 5000
    const samples = [
      { date: 1000, totalValue: 1000 },
      { date: 2000, totalValue: 800 },
      { date: 3000, totalValue: 900 },
      { date: 4000, totalValue: 950 },
      { date: 5000, totalValue: 1000 },
    ];
    expect(calculateLongestDrawdownDuration(samples, 1000)).toBe(4000);
  });

  it('should not mutate input array', () => {
    const samples = [
      { date: 1000, totalValue: 1000 },
      { date: 2000, totalValue: 900 },
    ];
    const copy = JSON.parse(JSON.stringify(samples));
    calculateLongestDrawdownDuration(samples, 1000);
    expect(samples).toEqual(copy);
  });
});

describe('calculateReturns', () => {
  it('should return empty array for fewer than 2 snapshots', () => {
    expect(calculateReturns([])).toEqual([]);
    expect(calculateReturns([{ date: 1, totalValue: 100 }])).toEqual([]);
  });

  it('should calculate returns correctly', () => {
    const snapshots = [
      { date: 1, totalValue: 100 },
      { date: 2, totalValue: 110 }, // +10%
      { date: 3, totalValue: 99 }, // -10% from 110
    ];
    // 110/100 - 1 = 0.1 (10%)
    // 99/110 - 1 = -0.1 (-10%)
    const result = calculateReturns(snapshots);
    expect(result).toHaveLength(2);
    expect(result[0]).toBeCloseTo(10);
    expect(result[1]).toBeCloseTo(-10);
  });

  it('should handle zero previous value (skip invalid returns)', () => {
    const snapshots = [
      { date: 1, totalValue: 0 },
      { date: 2, totalValue: 100 },
    ];
    // Should skip calculation where prev is 0
    expect(calculateReturns(snapshots)).toEqual([]);
  });

  it('should handle multiple zero values', () => {
    const snapshots = [
      { date: 1, totalValue: 100 },
      { date: 2, totalValue: 0 }, // -100%
      { date: 3, totalValue: 50 }, // skipped because prev is 0
    ];
    // 0/100 - 1 = -1 (-100%)
    const result = calculateReturns(snapshots);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeCloseTo(-100);
  });
});
