import { describe, expect, it } from 'vitest';
import { getPriceSignificantDigits, getPriceTick, roundToStep } from './precision.utils';

// Every value above 0 put on a step below is what ccxt 4.5.39 gives, as CCXTExchange calls it: decimalToPrecision with TRUNCATE for an
// amount, ROUND for a price (priceToPrecision on Binance), in the TICK_SIZE mode of Binance and Hyperliquid
describe('roundToStep', () => {
  it.each`
    value                     | step       | expected      | scenario
    ${0.00008595077805222816} | ${0.00001} | ${0.00008}    | ${'a quantity of GridBot, left unrounded'}
    ${0.015514114905047087}   | ${1e-8}    | ${0.01551411} | ${'an amount of 17 significant digits'}
    ${0.031028229810094173}   | ${0.00001} | ${0.03102}    | ${'an amount of 17 significant digits'}
    ${0.29}                   | ${0.01}    | ${0.29}       | ${'a multiple whose binary quotient is 28.999999999999996'}
    ${0.30000000000000004}    | ${0.01}    | ${0.3}        | ${'a binary sum'}
    ${1.005}                  | ${0.01}    | ${1}          | ${'a half, truncated'}
    ${0.0000099}              | ${0.00001} | ${0}          | ${'less than a step'}
    ${1234.5}                 | ${1}       | ${1234}       | ${'a step of one unit'}
    ${1239}                   | ${10}      | ${1230}       | ${'a step of ten units'}
    ${4705.33}                | ${10}      | ${4700}       | ${'a step of ten units, which rounding to the decimals of the step kept at 4705'}
    ${1.26}                   | ${0.5}     | ${1}          | ${'a step of half a unit'}
    ${1.4}                    | ${0.5}     | ${1}          | ${'a step of half a unit, which rounding to the decimals of the step kept at 1.4'}
    ${10.19}                  | ${0.2}     | ${10}         | ${'a step of two tenths'}
    ${1234}                   | ${500}     | ${1000}       | ${'a step of five hundred units'}
    ${0.37}                   | ${0.01}    | ${0.37}       | ${'a multiple'}
    ${0}                      | ${0.01}    | ${0}          | ${'zero'}
  `('truncates $value to $expected on a step of $step: $scenario', ({ value, step, expected }) => {
    expect(roundToStep(value, step, 'down')).toBe(expected);
  });

  it.each`
    value                   | step       | expected             | scenario
    ${1.005}                | ${0.01}    | ${1.01}              | ${'a half as it is written, 1.00499999999999989... in binary'}
    ${101.21000000000001}   | ${0.01}    | ${101.21}            | ${'the binary sum of a bid and price.min'}
    ${95.374}               | ${0.01}    | ${95.37}             | ${'under a half'}
    ${95.375}               | ${0.01}    | ${95.38}             | ${'a half'}
    ${61234.565}            | ${0.01}    | ${61234.57}          | ${'a half'}
    ${10.075}               | ${0.05}    | ${10.1}              | ${'a half of a step of five hundredths'}
    ${10.074}               | ${0.05}    | ${10.05}             | ${'under a half of a step of five hundredths'}
    ${10.09}                | ${0.2}     | ${10}                | ${'under a half of a step of two tenths, which rounding to tenths first would tie upwards'}
    ${10.1}                 | ${0.2}     | ${10.2}              | ${'a half of a step of two tenths'}
    ${1250}                 | ${500}     | ${1500}              | ${'a half of a step of five hundred units'}
    ${1249}                 | ${500}     | ${1000}              | ${'under a half of a step of five hundred units'}
    ${0.000004}             | ${0.00001} | ${0}                 | ${'under half a step'}
    ${0.015514114905047087} | ${1e-8}    | ${0.01551411}        | ${'17 significant digits'}
    ${0.031028229810094173} | ${0.00001} | ${0.03103}           | ${'17 significant digits, which a truncation takes to 0.03102'}
    ${12345678.123456785}   | ${1e-8}    | ${12345678.12345679} | ${'17 significant digits, more units of 1e-9 than 2 ** 53'}
  `('rounds $value to $expected on a step of $step: $scenario', ({ value, step, expected }) => {
    expect(roundToStep(value, step, 'up')).toBe(expected);
  });

  // Below 0, as round puts a value on a decimal: 'down' to the multiple below, 'up' to the nearest, a tie to the one above. GridBot
  // rounds a price of a grid below 0 so, which it reports; the simulator leaves a value below 0 as it is, for the limits to refuse it
  it.each`
    value      | step     | option    | expected   | scenario
    ${-1.234}  | ${0.01}  | ${'down'} | ${-1.24}   | ${'on a step of one unit of a decimal, to the multiple below'}
    ${-10.074} | ${0.05}  | ${'down'} | ${-10.1}   | ${'on a step of five hundredths, to the multiple below'}
    ${-1234}   | ${500}   | ${'down'} | ${-1500}   | ${'on a step of five hundred units, to the multiple below'}
    ${-1.005}  | ${0.01}  | ${'up'}   | ${-1}      | ${'a half, to the multiple above'}
    ${-10.075} | ${0.05}  | ${'up'}   | ${-10.05}  | ${'a half of a step of five hundredths, to the multiple above'}
    ${-10.076} | ${0.05}  | ${'up'}   | ${-10.1}   | ${'past the half of a step of five hundredths, to the nearest'}
    ${-1250}   | ${500}   | ${'up'}   | ${-1000}   | ${'a half of a step of five hundred units, to the multiple above'}
    ${-0.01}   | ${0.05}  | ${'up'}   | ${0}       | ${'nearer to 0 than to -0.05'}
    ${-6.25}   | ${0.25}  | ${'down'} | ${-6.25}   | ${'a multiple'}
    ${-6.375}  | ${0.25}  | ${'up'}   | ${-6.25}   | ${'a half of a step of a quarter, to the multiple above'}
    ${-6.376}  | ${0.25}  | ${'up'}   | ${-6.5}    | ${'past the half of a step of a quarter'}
    ${-0.0007} | ${0.001} | ${'down'} | ${-0.001}  | ${'under a step, to the multiple below'}
    ${-0.0004} | ${0.001} | ${'up'}   | ${-0}      | ${'under half a step, to 0, as round gives it'}
    ${-100.13} | ${0.05}  | ${'up'}   | ${-100.15} | ${'nearer to the multiple below'}
  `('puts $value on a step of $step, $option: $expected ($scenario)', ({ value, step, option, expected }) => {
    expect(roundToStep(value, step, option)).toBe(expected);
  });

  // Past 2 ** 53 in units of the decimal after the last one of the step, the multiple is worked out in binary
  it.each`
    value                 | option    | expected
    ${10000000000000.07}  | ${'down'} | ${10000000000000.05}
    ${10000000000000.08}  | ${'up'}   | ${10000000000000.1}
    ${-10000000000000.07} | ${'down'} | ${-10000000000000.1}
  `('puts $value on a step of 0.05 in binary, $option: $expected', ({ value, option, expected }) => {
    expect(roundToStep(value, 0.05, option)).toBe(expected);
  });

  it.each`
    value        | option
    ${NaN}       | ${'down'}
    ${Infinity}  | ${'down'}
    ${-Infinity} | ${'up'}
  `('leaves a value of $value as it is ($option)', ({ value, option }) => {
    expect(roundToStep(value, 0.01, option)).toBe(value);
  });

  // A step that is not a finite number above 0 is none, as market.utils reads a limit: the value is left as it is, as CCXTExchange leaves
  // a value the market has no precision for
  it.each`
    step
    ${undefined}
    ${0}
    ${-0.01}
    ${NaN}
    ${Infinity}
  `('leaves 0.123456789 as it is on a step of $step', ({ step }) => {
    expect(roundToStep(0.123456789, step, 'up')).toBe(0.123456789);
  });
});

describe('getPriceSignificantDigits', () => {
  it.each`
    precision                                    | expected     | description
    ${{ price: 0.1, priceSignificantDigits: 5 }} | ${5}         | ${'Hyperliquid 5'}
    ${{ priceSignificantDigits: 1 }}             | ${1}         | ${'1, without a tick'}
    ${{ price: 0.1 }}                            | ${undefined} | ${'none'}
    ${undefined}                                 | ${undefined} | ${'no precision'}
    ${{ priceSignificantDigits: 0 }}             | ${undefined} | ${'0'}
    ${{ priceSignificantDigits: -5 }}            | ${undefined} | ${'a negative number'}
    ${{ priceSignificantDigits: 4.5 }}           | ${undefined} | ${'a fraction'}
    ${{ priceSignificantDigits: NaN }}           | ${undefined} | ${'a value that is not a number'}
    ${{ priceSignificantDigits: Infinity }}      | ${undefined} | ${'an infinite value'}
  `('is $expected for a market that states $description', ({ precision, expected }) => {
    expect(getPriceSignificantDigits(precision)).toBe(expected);
  });
});

// Hyperliquid's rule (MarketData.precision.priceSignificantDigits): the coarser of precision.price and one unit of the 5th significant
// digit, one unit at most
describe('getPriceTick', () => {
  it.each`
    price                | precision                                      | expected     | scenario
    ${61234.56}          | ${{ price: 0.01 }}                             | ${0.01}      | ${'precision.price, without the rule'}
    ${61234.56}          | ${undefined}                                   | ${undefined} | ${'no precision'}
    ${10000.4}           | ${{ price: 0.1, priceSignificantDigits: 5 }}   | ${1}         | ${'from 10000 on'}
    ${9999.94}           | ${{ price: 0.1, priceSignificantDigits: 5 }}   | ${0.1}       | ${'under 10000'}
    ${12.345}            | ${{ price: 0.1, priceSignificantDigits: 5 }}   | ${0.1}       | ${'precision.price, the coarser'}
    ${12.345}            | ${{ priceSignificantDigits: 5 }}               | ${0.001}     | ${'no precision.price'}
    ${123456.7}          | ${{ priceSignificantDigits: 5 }}               | ${1}         | ${'an integer part of six digits, kept whole'}
    ${0.0012345}         | ${{ priceSignificantDigits: 5 }}               | ${1e-7}      | ${'a price under 1'}
    ${1.5e-7}            | ${{ priceSignificantDigits: 5 }}               | ${1e-11}     | ${'a price String writes with an exponent'}
    ${999.9999999999999} | ${{ priceSignificantDigits: 5 }}               | ${0.01}      | ${'a hair under 1000, where Math.log10 gives 3'}
    ${NaN}               | ${{ priceSignificantDigits: 5 }}               | ${undefined} | ${'a price that is no number'}
    ${0}                 | ${{ priceSignificantDigits: 5 }}               | ${undefined} | ${'a price of 0'}
    ${-10000.4}          | ${{ price: 0.1, priceSignificantDigits: 5 }}   | ${0.1}       | ${'a price below 0, precision.price'}
    ${10000.4}           | ${{ price: 0.1, priceSignificantDigits: 4.5 }} | ${0.1}       | ${'a fraction of a digit, which states no rule'}
    ${10000.4}           | ${{ price: 0.1, priceSignificantDigits: -5 }}  | ${0.1}       | ${'a negative count of digits, which states no rule'}
    ${12.345}            | ${{ price: 0.1, priceSignificantDigits: 0 }}   | ${0.1}       | ${'0 digits, which states no rule'}
  `('is $expected at $price with $precision: $scenario', ({ price, precision, expected }) => {
    expect(getPriceTick(price, precision)).toBe(expected);
  });
});
