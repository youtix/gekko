import { useTimeZone } from '@utils/date/date.mock';
import { describe, expect, it } from 'vitest';
import {
  calculateAlpha,
  calculateAnnualizedRatio,
  calculateAnnualizedReturnPct,
  calculateDownsideDeviation,
  calculateDrawdowns,
  calculateElapsedYears,
  calculateExposurePct,
  calculateMarketReturnPct,
  calculateReturns,
  calculateSharpeRatio,
  calculateSortinoRatio,
  calculateTotalReturnPct,
  calculateVolatility,
  calculateWinRate,
  extractTopMAEs,
} from './stats.helper';

/** An equity curve of these values, a second apart */
const curveOfValues = (values: number[]) => values.map((totalValue, index) => ({ date: index * 1000, totalValue }));
/** An equity curve of these [date, totalValue] points */
const curveOfPoints = (points: [number, number][]) => points.map(([date, totalValue]) => ({ date, totalValue }));

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

  it.each`
    startEquity
    ${0}
    ${-100}
  `('should throw for a startEquity of $startEquity', ({ startEquity }) => {
    expect(() => calculateTotalReturnPct(1000, startEquity)).toThrow('startEquity must be greater than zero');
  });
});

describe('calculateAnnualizedReturnPct', () => {
  // Worked out from the total return, rounded to 15 significant digits, the rows over a day of 2024 came out 4.87999999999999 and
  // 58.7368999999999: the digit the rounding dropped could not come back
  it.each`
    description                                                       | currentEquity | startEquity | elapsedYears | expected
    ${'1 year period'}                                                | ${1500}       | ${1000}     | ${1}         | ${50}
    ${'2 year period'}                                                | ${2000}       | ${1000}     | ${2}         | ${50}
    ${'half year period'}                                             | ${1250}       | ${1000}     | ${0.5}       | ${50}
    ${'negative return'}                                              | ${700}        | ${1000}     | ${2}         | ${-15}
    ${'very short period'}                                            | ${1100}       | ${1000}     | ${0.1}       | ${100}
    ${'long period'}                                                  | ${2000}       | ${1000}     | ${10}        | ${10}
    ${'0.3% over 3 years, 0.09999999999999999 in binary'}             | ${1003}       | ${1000}     | ${3}         | ${0.1}
    ${'a gain of 0.02% over a year, 0.01999999999999602 in binary'}   | ${1000.2}     | ${1000}     | ${1}         | ${0.02}
    ${'a gain of 40 on 300000 over a day of 2024, 1/366 of the year'} | ${300040}     | ${300000}   | ${1 / 366}   | ${4.88}
    ${'a loss of 40 on 300000 over a day of 2024'}                    | ${299960}     | ${300000}   | ${1 / 366}   | ${-4.88}
    ${'a gain of 481.45 on 300000 over a day of 2024'}                | ${300481.45}  | ${300000}   | ${1 / 366}   | ${58.7369}
  `('should return $expected for $description', ({ currentEquity, startEquity, elapsedYears, expected }) => {
    expect(calculateAnnualizedReturnPct(currentEquity, startEquity, elapsedYears)).toBe(expected);
  });

  it.each`
    elapsedYears
    ${0}
    ${-1}
  `('should throw for $elapsedYears elapsed years', ({ elapsedYears }) => {
    expect(() => calculateAnnualizedReturnPct(1500, 1000, elapsedYears)).toThrow('elapsedYears must be greater than zero');
  });

  it.each`
    startEquity
    ${0}
    ${-100}
  `('should throw for a startEquity of $startEquity', ({ startEquity }) => {
    expect(() => calculateAnnualizedReturnPct(1000, startEquity, 1)).toThrow('startEquity must be greater than zero');
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

  it.each`
    startPrice
    ${0}
    ${-50}
  `('should throw for a startPrice of $startPrice', ({ startPrice }) => {
    expect(() => calculateMarketReturnPct(100, startPrice)).toThrow('startPrice must be greater than zero');
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

  it.each`
    totalMs
    ${0}
    ${-1000}
  `('should throw for a period of $totalMs ms', ({ totalMs }) => {
    expect(() => calculateExposurePct(1000, totalMs)).toThrow('totalMs must be greater than zero');
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

describe('calculateVolatility', () => {
  // The population standard deviation: the square root of the mean of the squared deviations from the mean, over all n returns.
  // Returns all equal within compareWithTolerance have none: the deviation lodash's mean left them, 1.4e-17 for 0.1, 0.1 and 0.1, made
  // a Sharpe ratio of 6.2e17.
  it.each`
    description                                                        | returns                  | volatility | expected
    ${'no return'}                                                     | ${[]}                    | ${'0'}     | ${0}
    ${'a single return'}                                               | ${[5]}                   | ${'0'}     | ${0}
    ${'two returns 1.5 from their mean of 0.5'}                        | ${[2, -1]}               | ${'1.5'}   | ${1.5}
    ${'returns of mean 2.5, sqrt((6.25 + 42.25 + 90.25 + 30.25) / 4)'} | ${[5, -4, 12, -3]}       | ${'6.5'}   | ${6.5}
    ${'returns 2^-26 apart, 1.5e-8 of them, above the tolerance'}      | ${[1, 1 + 2 ** -26]}     | ${'2^-27'} | ${2 ** -27}
    ${'equal returns, 1.4e-17 from the mean lodash gives them'}        | ${[0.1, 0.1, 0.1]}       | ${'0'}     | ${0}
    ${'returns equal but for an ulp, 0.1 + 0.2 and 0.3'}               | ${[0.1 + 0.2, 0.3, 0.3]} | ${'0'}     | ${0}
    ${'a NaN return, among equal ones'}                                | ${[1, NaN, 1]}           | ${'NaN'}   | ${NaN}
  `('should return $volatility for $description', ({ returns, expected }) => {
    expect(calculateVolatility(returns)).toBe(expected);
  });
});

describe('calculateDownsideDeviation', () => {
  // The root mean square of the losses over all the n profits, gains counting as 0: sqrt(sum of squared losses / n)
  it.each`
    description                               | profits              | deviation           | expected
    ${'no profit'}                            | ${[]}                | ${'0'}              | ${0}
    ${'gains only'}                           | ${[10, 20, 30, 5]}   | ${'0'}              | ${0}
    ${'profits of 0'}                         | ${[0, 0, 0]}         | ${'0'}              | ${0}
    ${'a single gain'}                        | ${[5]}               | ${'0'}              | ${0}
    ${'a single loss'}                        | ${[-5]}              | ${'sqrt(25 / 1)'}   | ${5}
    ${'losses only'}                          | ${[-10, -20, -30]}   | ${'sqrt(1400 / 3)'} | ${Math.sqrt(1400 / 3)}
    ${'losses among gains, over all profits'} | ${[10, -10, 15, -5]} | ${'sqrt(125 / 4)'}  | ${Math.sqrt(125 / 4)}
  `('should return $deviation for $description', ({ profits, expected }) => {
    expect(calculateDownsideDeviation(profits)).toBe(expected);
  });
});

describe('extractTopMAEs', () => {
  it.each`
    description                                   | maes                                                   | limit        | expected
    ${'no MAE'}                                   | ${[]}                                                  | ${undefined} | ${[]}
    ${'fewer MAEs than the limit'}                | ${[5, 10, 3]}                                          | ${undefined} | ${[10, 5, 3]}
    ${'the 10 largest by default, largest first'} | ${[1, 12, 5, 8, 15, 3, 9, 2, 11, 7, 4, 6, 14, 13, 10]} | ${undefined} | ${[15, 14, 13, 12, 11, 10, 9, 8, 7, 6]}
    ${'a limit of 3'}                             | ${[10, 20, 5, 15, 8]}                                  | ${3}         | ${[20, 15, 10]}
    ${'negative MAEs left out'}                   | ${[10, -5, 20, -10, 15]}                               | ${undefined} | ${[20, 15, 10]}
    ${'NaN MAEs left out'}                        | ${[10, NaN, 20, NaN, 15]}                              | ${undefined} | ${[20, 15, 10]}
    ${'infinite MAEs left out'}                   | ${[10, Infinity, 20, -Infinity, 15]}                   | ${undefined} | ${[20, 15, 10]}
    ${'MAEs of 0 kept'}                           | ${[5, 0, 10, 0]}                                       | ${undefined} | ${[10, 5, 0, 0]}
  `('should return $expected for $description', ({ maes, limit, expected }) => {
    expect(extractTopMAEs(maes, limit)).toEqual(expected);
  });

  it('should not mutate the input array', () => {
    const maes = [5, 10, 3];
    const copy = [...maes];
    extractTopMAEs(maes);
    expect(maes).toEqual(copy);
  });
});

describe('calculateAnnualizedRatio', () => {
  // (yearlyProfit - riskFreeReturn) / (deviation * sqrt(n / elapsedYears)), n the number of returns, whatever their values:
  // (16 - 1) / (2 * sqrt(4 / 1)) = 3.75
  it.each`
    description                       | deviation | returns         | elapsedYears | expected
    ${'four returns over a year'}     | ${2}      | ${[1, 2, 3, 4]} | ${1}         | ${3.75}
    ${'four returns over four years'} | ${2}      | ${[1, 2, 3, 4]} | ${4}         | ${7.5}
    ${'four returns over a quarter'}  | ${2}      | ${[1, 2, 3, 4]} | ${0.25}      | ${1.875}
    ${'no return'}                    | ${2}      | ${[]}           | ${1}         | ${0}
    ${'zero elapsed years'}           | ${2}      | ${[1, 2, 3, 4]} | ${0}         | ${0}
    ${'negative elapsed years'}       | ${2}      | ${[1, 2, 3, 4]} | ${-1}        | ${0}
    ${'a deviation of 0'}             | ${0}      | ${[1, 2, 3, 4]} | ${1}         | ${0}
    ${'a NaN deviation'}              | ${NaN}    | ${[1, 2, 3, 4]} | ${1}         | ${0}
  `('should return $expected for $description', ({ deviation, returns, elapsedYears, expected }) => {
    expect(calculateAnnualizedRatio(deviation, { returns, yearlyProfit: 16, riskFreeReturn: 1, elapsedYears })).toBe(expected);
  });
});

describe('calculateSharpeRatio', () => {
  // The mean of the n returns, their population standard deviation (the square root of the mean of the squared deviations from that
  // mean, n in the denominator) annualized by sqrt(n / years), and the yearly profit less the risk-free return over it. So annualized,
  // the deviation is sqrt(sum of squared deviations / years):
  // - small losses among large gains, [5, -4, 12, -3] over a year: mean 2.5, sqrt(6.25 + 42.25 + 90.25 + 30.25) = 13, 15 / 13
  // - [3, -1], mean 1: over half a year sqrt((4 + 4) / 0.5) = 4, (21 - 1) / 4 = 5; over two years sqrt(8 / 2) = 2, 20 / 2 = 10
  // - a negative mean, [-5, 1, -2] over two years: mean -2, sqrt((9 + 9 + 0) / 2) = 3, (-4 - 2) / 3 = -2
  // - [2, -1, 3, -0.5, 2.5, 1] over a year: mean 7 / 6, squared deviations (25 + 169 + 121 + 100 + 64 + 1) / 36 = 40 / 3, a profit of
  //   15 then of 0.5 over a risk-free return of 2
  // Without the square root of the observations per year, the first row came out 15 / 26; with the sample deviation (n - 1), 0.9993.
  it.each`
    description                                                      | returns                       | yearlyProfit | riskFreeReturn | elapsedYears | sharpe                   | expected
    ${'small losses among large gains'}                              | ${[5, -4, 12, -3]}            | ${16}        | ${1}           | ${1}         | ${'15 / 13'}             | ${15 / 13}
    ${'two returns over half a year'}                                | ${[3, -1]}                    | ${21}        | ${1}           | ${0.5}       | ${'5'}                   | ${5}
    ${'the same returns over two years'}                             | ${[3, -1]}                    | ${21}        | ${1}           | ${2}         | ${'10'}                  | ${10}
    ${'returns of a negative mean'}                                  | ${[-5, 1, -2]}                | ${-4}        | ${2}           | ${2}         | ${'-2'}                  | ${-2}
    ${'a profit above the risk-free return'}                         | ${[2, -1, 3, -0.5, 2.5, 1]}   | ${15}        | ${2}           | ${1}         | ${'13 / sqrt(40 / 3)'}   | ${13 / Math.sqrt(40 / 3)}
    ${'a profit below the risk-free return'}                         | ${[2, -1, 3, -0.5, 2.5, 1]}   | ${0.5}       | ${2}           | ${1}         | ${'-1.5 / sqrt(40 / 3)'} | ${-1.5 / Math.sqrt(40 / 3)}
    ${'no return'}                                                   | ${[]}                         | ${10}        | ${1}           | ${1}         | ${'0'}                   | ${0}
    ${'zero elapsed years'}                                          | ${[1, 2, 3]}                  | ${10}        | ${1}           | ${0}         | ${'0'}                   | ${0}
    ${'negative elapsed years'}                                      | ${[1, 2, 3]}                  | ${10}        | ${1}           | ${-1}        | ${'0'}                   | ${0}
    ${'equal returns'}                                               | ${[5, 5, 5, 5]}               | ${10}        | ${1}           | ${1}         | ${'0'}                   | ${0}
    ${'equal returns of 0.1, 6.2e17 over the noise of their mean'}   | ${[0.1, 0.1, 0.1]}            | ${16}        | ${1}           | ${1}         | ${'0'}                   | ${0}
    ${'returns of 1000, 1001 and 1002.001, 0.1 % each, 8.9e15 then'} | ${[0.1, 0.09999999999999763]} | ${16}        | ${1}           | ${1}         | ${'0'}                   | ${0}
    ${'a NaN return'}                                                | ${[1, NaN, 2]}                | ${16}        | ${1}           | ${1}         | ${'0'}                   | ${0}
  `('should return $sharpe for $description', ({ returns, yearlyProfit, riskFreeReturn, elapsedYears, expected }) => {
    expect(calculateSharpeRatio({ returns, yearlyProfit, riskFreeReturn, elapsedYears })).toBeCloseTo(expected, 12);
  });
});

describe('calculateSortinoRatio', () => {
  // Downside deviation over the n returns, gains counting as 0: sqrt(sum of squared losses / n). Annualized by sqrt(n / years),
  // it simplifies to sqrt(sum of squared losses / years). All rows but the last two earn 16 - 1 = 15 points over the risk-free return:
  // - single loss, [3, -4, 5] over 1 year: sqrt(16 / 1) = 4, 15 / 4 = 3.75
  // - equal losses, [-2, -2, -2, 5, 5] over 3 years: sqrt((4 + 4 + 4) / 3) = 2, 15 / 2 = 7.5
  // - losses of 1 and 3, [5, -1, -3] over 1 year: sqrt(1 + 9), 15 / sqrt(10)
  // - losses of 11 and 13, [5, -11, -13] over 1 year: sqrt(121 + 169), 15 / sqrt(290)
  // - small losses among large gains, [5, -4, 12, -3] over 1 year: sqrt(16 + 9) = 5, 15 / 5 = 3, where the Sharpe ratio is 15 / 13
  // - below the risk-free return, [3, -4, 5] over 1 year earning 1 - 3 = -2: -2 / 4 = -0.5
  // - equal losses of 0.1, [-0.1, -0.1, -0.1] over 1 year earning -30 - 1 = -31: sqrt(0.01 + 0.01 + 0.01), -31 / sqrt(0.03). Equal
  //   losses keep their downside deviation: unlike the volatility of equal returns, it is not measured from their mean
  // The stdev of the losses around their own mean, used before, gave 0 for the first two rows, 8.660254 for both of the next
  // two and 15 for the small losses.
  it.each`
    description                                   | returns               | yearlyProfit | riskFreeReturn | elapsedYears | sortino               | expected
    ${'return 0 for an empty returns array'}      | ${[]}                 | ${16}        | ${1}           | ${1}         | ${'0'}                | ${0}
    ${'return 0 for zero elapsed years'}          | ${[5, -1, -3]}        | ${16}        | ${1}           | ${0}         | ${'0'}                | ${0}
    ${'return 0 for negative elapsed years'}      | ${[5, -1, -3]}        | ${16}        | ${1}           | ${-1}        | ${'0'}                | ${0}
    ${'return 0 when no return is a loss'}        | ${[1, 0, 3]}          | ${16}        | ${1}           | ${1}         | ${'0'}                | ${0}
    ${'count a single loss as downside risk'}     | ${[3, -4, 5]}         | ${16}        | ${1}           | ${1}         | ${'3.75'}             | ${3.75}
    ${'count equal losses as downside risk'}      | ${[-2, -2, -2, 5, 5]} | ${16}        | ${1}           | ${3}         | ${'7.5'}              | ${7.5}
    ${'weigh losses of 1 and 3 by their size'}    | ${[5, -1, -3]}        | ${16}        | ${1}           | ${1}         | ${'15 / sqrt(10)'}    | ${15 / Math.sqrt(10)}
    ${'weigh losses of 11 and 13 by their size'}  | ${[5, -11, -13]}      | ${16}        | ${1}           | ${1}         | ${'15 / sqrt(290)'}   | ${15 / Math.sqrt(290)}
    ${'not count the gains as risk'}              | ${[5, -4, 12, -3]}    | ${16}        | ${1}           | ${1}         | ${'3'}                | ${3}
    ${'turn negative below the risk-free return'} | ${[3, -4, 5]}         | ${1}         | ${3}           | ${1}         | ${'-0.5'}             | ${-0.5}
    ${'count equal losses of 0.1 in full'}        | ${[-0.1, -0.1, -0.1]} | ${-30}       | ${1}           | ${1}         | ${'-31 / sqrt(0.03)'} | ${-31 / Math.sqrt(0.03)}
  `('should $description: $sortino', ({ returns, yearlyProfit, riskFreeReturn, elapsedYears, expected }) => {
    expect(calculateSortinoRatio({ returns, yearlyProfit, riskFreeReturn, elapsedYears })).toBeCloseTo(expected, 12);
  });
});

describe('calculateDrawdowns', () => {
  // The exchanges book a cost to 8 decimals, while a holding is valued at amount × price, up to 5e-9 above or below the currency it
  // cost: within a booked unit of the peak, a sample is at it. The curve valued 5e-9 above its cost had a drawdown of 5e-10 % that
  // lasted to its end, the one valued 5e-9 below a drawdown until it got back
  it.each`
    description                                               | points                                                                | initialBalance | maxDrawdownPct | longestDrawdownMs
    ${'no sample'}                                            | ${[]}                                                                 | ${1000}        | ${0}           | ${0}
    ${'an initial balance of 0'}                              | ${[[0, 900], [1000, 800]]}                                            | ${0}           | ${0}           | ${0}
    ${'a negative initial balance'}                           | ${[[0, 900], [1000, 800]]}                                            | ${-100}        | ${0}           | ${0}
    ${'a NaN initial balance, which no sample compares with'} | ${[[0, 900], [1000, 800]]}                                            | ${NaN}         | ${0}           | ${0}
    ${'the deepest drawdown short, a shallower one long'}     | ${[[0, 1000], [1000, 800], [2000, 1000], [3000, 950], [20000, 1000]]} | ${1000}        | ${20}          | ${18000}
    ${'a holding valued 5e-9 above its cost, then sold'}      | ${[[0, 1000], [1000, 1000.000000005], [2000, 1000], [3000, 1000]]}    | ${1000}        | ${0}           | ${0}
    ${'a holding valued 5e-9 below its cost, then sold'}      | ${[[0, 1000], [1000, 999.999999995], [2000, 1000]]}                   | ${1000}        | ${0}           | ${0}
    ${'a dip of 1e-7, ten booked units'}                      | ${[[0, 1000], [1000, 999.9999999], [2000, 1000]]}                     | ${1000}        | ${1e-8}        | ${2000}
  `(
    'should return a max drawdown of $maxDrawdownPct % and a longest of $longestDrawdownMs ms for $description',
    ({ points, initialBalance, maxDrawdownPct, longestDrawdownMs }) => {
      expect(calculateDrawdowns(curveOfPoints(points), initialBalance)).toStrictEqual({ maxDrawdownPct, longestDrawdownMs });
    },
  );

  describe('the largest drawdown', () => {
    it.each`
      description                                                   | balances                                | initialBalance | expected
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
      expect(calculateDrawdowns(curveOfValues(balances), initialBalance).maxDrawdownPct).toBe(expected);
    });
  });

  describe('the longest drawdown', () => {
    // From a peak to the sample that gets back to it, or to the last sample; the start equity, 1000, is the first peak, dated with the
    // first sample. Kept, not replaced: a later drawdown shorter than the longest leaves it, recovered or not
    it.each`
      description                                                        | points                                                                   | expected
      ${'a curve that never falls below its peak'}                       | ${[[1000, 1000], [2000, 1100]]}                                          | ${0}
      ${'a single drawdown recovered'}                                   | ${[[1000, 1000], [2000, 900], [3000, 1000]]}                             | ${2000}
      ${'a drawdown recovered to the peak exactly'}                      | ${[[1000, 1000], [2000, 800], [3000, 900], [4000, 950], [5000, 1000]]}   | ${4000}
      ${'a drawdown from the start equity, dated with the first sample'} | ${[[1000, 900], [5000, 1000]]}                                           | ${4000}
      ${'two drawdowns, each ended by a sample equal to the peak'}       | ${[[0, 1000], [1000, 900], [2000, 1000], [3000, 900], [4000, 1000]]}     | ${2000}
      ${'a drawdown recovered, then a longer one'}                       | ${[[1000, 1000], [2000, 900], [3000, 1000], [4000, 800], [10000, 1000]]} | ${7000}
      ${'a drawdown recovered, then a shorter one'}                      | ${[[0, 1000], [1000, 900], [9000, 1000], [10000, 950], [11000, 1000]]}   | ${9000}
      ${'a single drawdown still in progress'}                           | ${[[1000, 1000], [2000, 900]]}                                           | ${1000}
      ${'a drawdown recovered, then a longer one still in progress'}     | ${[[0, 1000], [1000, 900], [2000, 1000], [3000, 950], [10000, 950]]}     | ${8000}
      ${'a drawdown recovered, then a shorter one still in progress'}    | ${[[0, 1000], [1000, 900], [9000, 1000], [10000, 950]]}                  | ${9000}
      ${'a NaN sample, which is skipped'}                                | ${[[0, 1000], [5, 900], [7, NaN], [9, 1000]]}                            | ${9}
    `('should return $expected ms for $description', ({ points, expected }) => {
      expect(calculateDrawdowns(curveOfPoints(points), 1000).longestDrawdownMs).toBe(expected);
    });
  });

  it('should leave the curve as it was', () => {
    const curve = curveOfPoints([
      [1000, 1000],
      [2000, 900],
    ]);
    const copy = structuredClone(curve);
    calculateDrawdowns(curve, 1000);
    expect(curve).toEqual(copy);
  });
});

describe('calculateReturns', () => {
  // The change from each value of the curve to the next, in % of the first: (110 - 100) / 100 * 100 = 10. A value of 0 or less starts no
  // return. A change of less than a booked unit is none: a holding valued 5e-9 above its cost, then sold, made returns of 5e-10 % and
  // -5e-10 %
  it.each`
    description                                          | values                          | expected
    ${'no snapshot'}                                     | ${[]}                           | ${[]}
    ${'a single snapshot'}                               | ${[100]}                        | ${[]}
    ${'a gain of 10 % then a loss of 10 %'}              | ${[100, 110, 99]}               | ${[10, -10]}
    ${'a start at 0'}                                    | ${[0, 100]}                     | ${[]}
    ${'a fall to 0, then a value after it'}              | ${[100, 0, 50]}                 | ${[-100]}
    ${'a negative value'}                                | ${[-100, 50]}                   | ${[]}
    ${'a holding valued 5e-9 above its cost, then sold'} | ${[1000, 1000.000000005, 1000]} | ${[0, 0]}
  `('should return $expected for $description', ({ values, expected }) => {
    expect(calculateReturns(curveOfValues(values))).toEqual(expected);
  });

  it('should return a change of 1e-7, ten booked units, as a gain', () => {
    expect(calculateReturns(curveOfValues([1000, 1000.0000001]))[0]).toBeGreaterThan(0);
  });
});
