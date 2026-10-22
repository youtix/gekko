import { describe, expect, it } from 'vitest';
import { countDecimals, round, shiftDecimalPoint } from './round.utils';

describe('round', () => {
  // Scaled by a binary product, these decimals landed on the wrong side of the floor or of the tie: 8.2 * 100 is 819.9999999999999,
  // 1.005 * 100 is 100.49999999999999, -2.345 * 100 is -234.50000000000003. Of 17 significant digits, the scaled decimal itself can be
  // read as the double past the floor or on the tie: at 8 decimals 2752.0325676499997 is 275203256764.99997, read as 275203256765,
  // 1466135.4430033849 is 146613544300338.49, read as 146613544300338.5, and 45036738.172290705 is 4503673817229070.5, read as
  // 4503673817229070.
  it.each`
    value                  | decimals | option        | expected
    ${0.29}                | ${2}     | ${'down'}     | ${0.29}
    ${8.2}                 | ${2}     | ${'down'}     | ${8.2}
    ${4.35}                | ${2}     | ${'down'}     | ${4.35}
    ${1.13}                | ${2}     | ${'down'}     | ${1.13}
    ${-1.1}                | ${2}     | ${'down'}     | ${-1.1}
    ${8.29}                | ${8}     | ${'down'}     | ${8.29}
    ${10000000000000.03}   | ${2}     | ${'down'}     | ${10000000000000.03}
    ${2752.0325676499997}  | ${8}     | ${'down'}     | ${2752.03256764}
    ${384858.05310263997}  | ${8}     | ${'down'}     | ${384858.05310263}
    ${-368081.71569327003} | ${8}     | ${'down'}     | ${-368081.71569328}
    ${1.005}               | ${2}     | ${'up'}       | ${1.01}
    ${0.285}               | ${2}     | ${'up'}       | ${0.29}
    ${8.52095}             | ${4}     | ${'up'}       | ${8.521}
    ${-0.000009745}        | ${8}     | ${'up'}       | ${-0.00000974}
    ${-2752.0325676499997} | ${8}     | ${'up'}       | ${-2752.03256765}
    ${-384858.05310263997} | ${8}     | ${'up'}       | ${-384858.05310264}
    ${1466135.4430033849}  | ${8}     | ${'up'}       | ${1466135.44300338}
    ${-395603.82968810503} | ${8}     | ${'up'}       | ${-395603.82968811}
    ${45036738.172290705}  | ${8}     | ${'up'}       | ${45036738.17229071}
    ${1.015}               | ${2}     | ${'halfEven'} | ${1.02}
    ${2.345}               | ${2}     | ${'halfEven'} | ${2.34}
    ${-2.345}              | ${2}     | ${'halfEven'} | ${-2.34}
    ${-0.00015}            | ${4}     | ${'halfEven'} | ${-0.0002}
    ${1911489.0591592651}  | ${8}     | ${'halfEven'} | ${1911489.05915927}
    ${2948480.1765622348}  | ${8}     | ${'halfEven'} | ${2948480.17656223}
    ${-15355.072432174999} | ${8}     | ${'halfEven'} | ${-15355.07243217}
  `('should round the decimal $value $option to $decimals decimals as $expected', ({ value, decimals, option, expected }) => {
    expect(round(value, decimals, option)).toBe(expected);
  });

  it.each`
    description                                       | value                    | decimals | option        | expected
    ${'floor an inexact value'}                       | ${0.123456}              | ${2}     | ${'down'}     | ${0.12}
    ${'floor a negative value away from zero'}        | ${-8.199}                | ${2}     | ${'down'}     | ${-8.2}
    ${'floor a product read as the integer below it'} | ${27398.933309980002}    | ${8}     | ${'down'}     | ${27398.93330998}
    ${'round an inexact value to the nearest'}        | ${0.123456}              | ${2}     | ${'up'}       | ${0.12}
    ${'round a tie up'}                               | ${2.5}                   | ${0}     | ${'up'}       | ${3}
    ${'round a negative tie up, towards zero'}        | ${-1.005}                | ${2}     | ${'up'}       | ${-1}
    ${'round a large tie up'}                         | ${1000000000000000.5}    | ${0}     | ${'up'}       | ${1000000000000001}
    ${'round up a tie read as the integer above it'}  | ${45074426.959266335}    | ${8}     | ${'up'}       | ${45074426.95926634}
    ${'round a tie to the even decimal below'}        | ${1.005}                 | ${2}     | ${'halfEven'} | ${1}
    ${'round a tie to the even decimal above'}        | ${0.135}                 | ${2}     | ${'halfEven'} | ${0.14}
    ${'round a tie read as its even integer to it'}   | ${45036738.172290705}    | ${8}     | ${'halfEven'} | ${45036738.1722907}
    ${'round a value above a tie to the nearest'}     | ${1.016}                 | ${2}     | ${'halfEven'} | ${1.02}
    ${'round a value below a tie to the nearest'}     | ${1.014}                 | ${2}     | ${'halfEven'} | ${1.01}
    ${'round a value written with an exponent'}       | ${1.23e-7}               | ${8}     | ${'down'}     | ${1.2e-7}
    ${'round to hundreds with negative decimals'}     | ${1250}                  | ${-2}    | ${'halfEven'} | ${1200}
    ${'give back a value with fewer decimals'}        | ${8.2}                   | ${4}     | ${'down'}     | ${8.2}
    ${'give back a value of 16 digits as it is'}      | ${-808529525.9952545}    | ${8}     | ${'up'}       | ${-808529525.9952545}
    ${'give back a large integer'}                    | ${1e15}                  | ${2}     | ${'down'}     | ${1e15}
    ${'give back an integer beyond 2 ** 53 scaled'}   | ${1e21}                  | ${2}     | ${'up'}       | ${1e21}
    ${'give back a multiple of ten beyond 2 ** 53'}   | ${123456789012345680000} | ${-1}    | ${'down'}     | ${123456789012345680000}
    ${'give back zero'}                               | ${0}                     | ${2}     | ${'down'}     | ${0}
    ${'give back -0'}                                 | ${-0}                    | ${2}     | ${'down'}     | ${-0}
    ${'round a small gain down to 0'}                 | ${0.004}                 | ${2}     | ${'down'}     | ${0}
    ${'round a small loss up to -0, as Math.round'}   | ${-0.004}                | ${2}     | ${'up'}       | ${-0}
    ${'give back NaN'}                                | ${NaN}                   | ${2}     | ${'up'}       | ${NaN}
    ${'give back Infinity'}                           | ${Infinity}              | ${2}     | ${'down'}     | ${Infinity}
    ${'give back -Infinity'}                          | ${-Infinity}             | ${2}     | ${'halfEven'} | ${-Infinity}
    ${'give back Infinity with negative decimals'}    | ${Infinity}              | ${-1}    | ${'up'}       | ${Infinity}
  `('should $description', ({ value, decimals, option, expected }) => {
    expect(round(value, decimals, option)).toBe(expected);
  });

  it('should round to an integer, a tie up, by default', () => {
    expect(round(2.5)).toBe(3);
  });
});

// addPrecise moves its operands with these too: they read the digits String writes, where 8.2 * 100 is 819.9999999999999 in binary
describe('shiftDecimalPoint', () => {
  it.each`
    value     | places  | expected
    ${8.2}    | ${2}    | ${820}
    ${820}    | ${-2}   | ${8.2}
    ${1.5e-7} | ${7}    | ${1.5}
    ${12345}  | ${-2}   | ${123.45}
    ${5}      | ${-324} | ${5e-324}
    ${-0}     | ${3}    | ${-0}
  `('should move the decimal point of $value by $places places to $expected', ({ value, places, expected }) => {
    expect(shiftDecimalPoint(value, places)).toBe(expected);
  });
});

describe('countDecimals', () => {
  // Below 0, the zeros an integer ends with: 1200 needs no rounding to tens or hundreds
  it.each`
    value     | expected
    ${8.25}   | ${2}
    ${-2.5}   | ${1}
    ${1.5e-7} | ${8}
    ${5e-324} | ${324}
    ${1200}   | ${-2}
    ${-1200}  | ${-2}
    ${1e21}   | ${-21}
  `('should count $expected decimals in $value', ({ value, expected }) => {
    expect(countDecimals(value)).toBe(expected);
  });
});
