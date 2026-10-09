import { describe, expect, it } from 'vitest';
import { addPrecise, compareWithTolerance, isFiniteNumber, multiplyPrecise, stdev, toSignificantDigits } from './math.utils';

describe('stdev', () => {
  it.each`
    description                               | input                        | expected
    ${'return NaN when input is undefined'}   | ${undefined}                 | ${NaN}
    ${'return NaN when input is null'}        | ${null}                      | ${NaN}
    ${'return NaN when input is empty array'} | ${[]}                        | ${NaN}
    ${'return zero when only one input'}      | ${[42.4242]}                 | ${0}
    ${'return stdev of input'}                | ${[2, 4, 4, 4, 5, 5, 7, 9]}  | ${2}
    ${'return a stdev with decimals'}         | ${[600, 470, 170, 430, 300]} | ${147.32277488562318}
  `('should $description', ({ input, expected }) => {
    expect(stdev(input)).toBe(expected);
  });
});

describe('addPrecise', () => {
  // 1.2345678901234567, its decimal point moved by its 16 decimals, is 12345678901234567, past 2 ** 53, which a double holds as
  // 12345678901234568: added to -0.5 so moved, the sum, back under 2 ** 53, would read back as 0.7345678901234568. addPrecise is then
  // a + b, as for a sum past 2 ** 53. Moved by a binary product, the values came back off from 2 ** 51 already, further than a + b.
  // From 2 ** 26 at 8 decimals doubles lie more than 1e-8 apart: the double nearest to 72046258.80743521 + 1e-8 is the one String
  // writes 72046258.80743521, so the change is lost, where a + b is 72046258.80743523.
  it.each`
    description                                               | a                     | b                     | expected
    ${'0.1 + 0.2, 0.30000000000000004 in binary'}             | ${0.1}                | ${0.2}                | ${0.3}
    ${'1.005 + 0.005, 1.0099999999999998 in binary'}          | ${1.005}              | ${0.005}              | ${1.01}
    ${'2.5 - 2.2, 0.2999999999999998 in binary'}              | ${2.5}                | ${-2.2}               | ${0.3}
    ${'0.3 - 0.1, 0.19999999999999998 in binary'}             | ${0.3}                | ${-0.1}               | ${0.2}
    ${'values the binary sum adds right'}                     | ${123.456}            | ${0.444}              | ${123.9}
    ${'zeros'}                                                | ${0}                  | ${0}                  | ${0}
    ${'negative zeros, a negative zero'}                      | ${-0}                 | ${-0}                 | ${-0}
    ${'a negative value'}                                     | ${-1.1}               | ${2.2}                | ${1.1}
    ${'values written with an exponent'}                      | ${1e-7}               | ${2e-7}               | ${3e-7}
    ${'a sum without decimals'}                               | ${1.234567}           | ${8.765433}           | ${10}
    ${'16 digits, an ulp below through a binary product'}     | ${567095.51811}       | ${57385.8976364135}   | ${624481.4157464135}
    ${'16 digits, an ulp above through a binary product'}     | ${4310369.491577148}  | ${3184194.5648193}    | ${7494564.056396448}
    ${'16 digits, a change below an ulp lost'}                | ${72046258.80743521}  | ${1e-8}               | ${72046258.80743521}
    ${'past 2 ** 53 once moved: a + b, not an ulp above'}     | ${123456.78901234567} | ${1e-8}               | ${123456.78901235567}
    ${'the first past 2 ** 53 once moved, the sum under it'}  | ${1.2345678901234567} | ${-0.5}               | ${0.7345678901234567}
    ${'the second past 2 ** 53 once moved, the sum under it'} | ${-0.5}               | ${1.2345678901234567} | ${0.7345678901234567}
    ${'both under 2 ** 53 once moved, their sum past it'}     | ${583868605058252.8}  | ${478743844670668.7}  | ${1062612449728921.5}
    ${'310 decimals, NaN through a binary product'}           | ${1e-300}             | ${1e-310}             | ${1.0000000001e-300}
    ${'NaN, as a + b'}                                        | ${NaN}                | ${1}                  | ${NaN}
    ${'Infinity, as a + b'}                                   | ${Infinity}           | ${1}                  | ${Infinity}
  `('should return $expected for $a + $b: $description', ({ a, b, expected }) => {
    expect(addPrecise(a, b)).toBe(expected);
  });
});

// The first five come out an ulp or two off the decimal in binary (100.01 × 0.0004 is 0.040004000000000005). The last three are the
// cost of an 8-decimal amount at a 2-decimal price, of 16 or 17 digits written with 10 decimals. At 16 the binary product rounded to
// them is mostly the exact cost, which a × b misses (255967.34235133752), but can land a unit off it, farther than a × b: the cost
// 507659.0650224936 is 507659.06502249365 in binary. From 17, a × b: 1219326.2861880813 is 1219326.2861880811.
describe('multiplyPrecise', () => {
  it.each`
    a              | b           | expected
    ${100.01}      | ${0.0004}   | ${0.040004}
    ${101.21}      | ${0.3}      | ${30.363}
    ${61234.56}    | ${0.7}      | ${42864.192}
    ${0.0007}      | ${100}      | ${0.07}
    ${0.07}        | ${1200}     | ${84}
    ${4.99825}     | ${100.01}   | ${499.8749825}
    ${1200}        | ${0.5}      | ${600}
    ${0.3}         | ${0}        | ${0}
    ${4.34965385}  | ${58847.75} | ${255967.3423513375}
    ${5.65849689}  | ${89716.24} | ${507659.0650224937}
    ${12.34567891} | ${98765.43} | ${1219326.2861880811}
  `('gives $expected for $a × $b', ({ a, b, expected }) => {
    expect(multiplyPrecise(a, b)).toBe(expected);
  });
});

// Made in binary: 101.2 + 0.01, 0.0007 × 100 and 0.3 / 0.1. With no end: 302 / 3, and 0.1 / 3 × 1e-9 for the tiny value. The double
// itself is rounded, not the shortest decimal String writes for it: 4000000 / 7, written 571428.5714285715, is 571428.57142857147…
// (the quotient 571428.57142857142…) and -500 / 1968, written -0.2540650406504065, is -0.25406504065040652… Rounded as written, a tie
// up, they gave 571428.571428572 and -0.254065040650406, and 1.797693134862315e308 gave 1.79769313486232e308, past the largest double:
// Infinity. Just under a power of ten, the two of 15 digits kept a digit less with an exponent read from Math.log10, 10 and -12.
describe('toSignificantDigits', () => {
  it.each`
    description                                | value                     | expected
    ${'a sum made in binary'}                  | ${101.21000000000001}     | ${101.21}
    ${'a product made in binary'}              | ${0.06999999999999999}    | ${0.07}
    ${'a quotient made in binary'}             | ${2.9999999999999996}     | ${3}
    ${'a negative value made in binary'}       | ${-0.06999999999999999}   | ${-0.07}
    ${'a quotient with no end, to 15 digits'}  | ${100.66666666666667}     | ${100.666666666667}
    ${'a tiny value, to 15 digits'}            | ${3.3333333333333335e-11} | ${3.33333333333333e-11}
    ${'a large value, to 15 digits'}           | ${123456789012345680000}  | ${123456789012346000000}
    ${'a quotient whose written 5 is no tie'}  | ${4000000 / 7}            | ${571428.571428571}
    ${'a negative quotient whose 5 is no tie'} | ${-500 / 1968}            | ${-0.254065040650407}
    ${'a tie in binary, away from zero'}       | ${100000000000000.5}      | ${100000000000001}
    ${'a negative tie, away from zero'}        | ${-100000000000000.5}     | ${-100000000000001}
    ${'near the largest double, still finite'} | ${1.797693134862315e308}  | ${1.79769313486231e308}
    ${'a value of fewer digits, as it is'}     | ${0.04}                   | ${0.04}
    ${'15 digits just under 1e10, as it is'}   | ${9999999999.99998}       | ${9999999999.99998}
    ${'15 digits just under 1e-12, as it is'}  | ${9.99999999999999e-13}   | ${9.99999999999999e-13}
    ${'0, as it is'}                           | ${0}                      | ${0}
    ${'-0, as it is'}                          | ${-0}                     | ${-0}
    ${'NaN, as it is'}                         | ${NaN}                    | ${NaN}
    ${'Infinity, as it is'}                    | ${Infinity}               | ${Infinity}
    ${'-Infinity, as it is'}                   | ${-Infinity}              | ${-Infinity}
  `('should give $expected for $value, $description', ({ value, expected }) => {
    expect(toSignificantDigits(value)).toBe(expected);
  });
});

describe('isFiniteNumber', () => {
  it.each`
    value               | expected
    ${0}                | ${true}
    ${-2.5}             | ${true}
    ${Number.MAX_VALUE} | ${true}
    ${NaN}              | ${false}
    ${Infinity}         | ${false}
    ${-Infinity}        | ${false}
    ${null}             | ${false}
    ${undefined}        | ${false}
    ${'1'}              | ${false}
  `('should tell whether $value is a finite number: $expected', ({ value, expected }) => {
    expect(isFiniteNumber(value)).toBe(expected);
  });
});

describe('compareWithTolerance', () => {
  // 2 ** 30 + 1 lies 9.3e-10 of 2 ** 30 away from it, within the default tolerance of 1e-9, and 2 ** 30 + 2 lies 1.9e-9 away
  it.each`
    description                                                             | a                     | b                     | expected
    ${'equal values'}                                                       | ${30081.93}           | ${30081.93}           | ${0}
    ${'the running-sum SMA of a flat window at 30081.93, 17 ulps above it'} | ${30081.930000000062} | ${30081.93}           | ${0}
    ${'a flat price 17 ulps below its running-sum SMA'}                     | ${30081.93}           | ${30081.930000000062} | ${0}
    ${'hlc3 of a flat candle at 30081.93, one ulp above its close'}         | ${30081.930000000004} | ${30081.93}           | ${0}
    ${'a value within the default tolerance above another'}                 | ${2 ** 30 + 1}        | ${2 ** 30}            | ${0}
    ${'a value beyond the default tolerance above another'}                 | ${2 ** 30 + 2}        | ${2 ** 30}            | ${1}
    ${'a value beyond the default tolerance below another'}                 | ${2 ** 30}            | ${2 ** 30 + 2}        | ${-1}
    ${'a price a tick of 0.01 above another, on 100000'}                    | ${100000.01}          | ${100000}             | ${1}
    ${'a price a tick of 0.01 below another, on 100000'}                    | ${99999.99}           | ${100000}             | ${-1}
    ${'negative values within the tolerance'}                               | ${-(2 ** 30) - 1}     | ${-(2 ** 30)}         | ${0}
    ${'negative values beyond it'}                                          | ${-1}                 | ${-2}                 | ${1}
    ${'0 and -0'}                                                           | ${0}                  | ${-0}                 | ${0}
    ${'a tiny value and 0, never within a tolerance relative to them'}      | ${1e-300}             | ${0}                  | ${1}
    ${'0 and a tiny negative value'}                                        | ${0}                  | ${-1e-300}            | ${1}
    ${'tiny values of opposite signs'}                                      | ${-1e-12}             | ${1e-12}              | ${-1}
    ${'Infinity and itself'}                                                | ${Infinity}           | ${Infinity}           | ${0}
    ${'Infinity and the largest finite value'}                              | ${Infinity}           | ${Number.MAX_VALUE}   | ${1}
    ${'-Infinity and a finite value'}                                       | ${-Infinity}          | ${0}                  | ${-1}
    ${'values whose difference overflows to Infinity'}                      | ${Number.MAX_VALUE}   | ${-Number.MAX_VALUE}  | ${1}
    ${'NaN and a value'}                                                    | ${NaN}                | ${1}                  | ${NaN}
    ${'a value and NaN'}                                                    | ${1}                  | ${NaN}                | ${NaN}
  `('should compare $description as $expected', ({ a, b, expected }) => {
    expect(compareWithTolerance(a, b)).toBe(expected);
  });

  // The tolerance is a share of the larger magnitude: 1 apart is within 25 % of 4, whichever of 3 and 4 comes first, not of 3
  it.each`
    description                                           | a                     | b           | tolerance | expected
    ${'values within 1 %'}                                | ${101}                | ${100}      | ${0.01}   | ${0}
    ${'values beyond 1 %'}                                | ${102}                | ${100}      | ${0.01}   | ${1}
    ${'4 and 3, 25 % of 4 apart'}                         | ${4}                  | ${3}        | ${0.25}   | ${0}
    ${'3 and 4, 25 % of 4 apart'}                         | ${3}                  | ${4}        | ${0.25}   | ${0}
    ${'3 and 2, beyond 25 % of 3'}                        | ${3}                  | ${2}        | ${0.25}   | ${1}
    ${'a running-sum SMA, exactly with a tolerance of 0'} | ${30081.930000000062} | ${30081.93} | ${0}      | ${1}
  `('should compare $description with a tolerance of $tolerance as $expected', ({ a, b, tolerance, expected }) => {
    expect(compareWithTolerance(a, b, tolerance)).toBe(expected);
  });
});
