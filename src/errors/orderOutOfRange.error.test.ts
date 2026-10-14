import { describe, expect, it } from 'vitest';
import { GekkoError } from './gekko.error';
import { OrderOutOfRangeError } from './orderOutOfRange.error';

// The message is `[TAG] Order '<property>' with value <said>`: the tables give what follows "with value"
describe('OrderOutOfRangeError', () => {
  // A value refused whatever the limits, then a value out of the range, under the minimum or over the maximum the market sets
  it.each`
    property    | current      | min          | max            | said
    ${'price'}  | ${NaN}       | ${10}        | ${100}         | ${'NaN is invalid. Expected a finite number greater than 0.'}
    ${'amount'} | ${Infinity}  | ${undefined} | ${undefined}   | ${'Infinity is invalid. Expected a finite number greater than 0.'}
    ${'amount'} | ${-Infinity} | ${1}         | ${undefined}   | ${'-Infinity is invalid. Expected a finite number greater than 0.'}
    ${'amount'} | ${0}         | ${0.00001}   | ${9000}        | ${'0 is invalid. Expected a finite number greater than 0.'}
    ${'amount'} | ${-1}        | ${undefined} | ${10}          | ${'-1 is invalid. Expected a finite number greater than 0.'}
    ${'cost'}   | ${5}         | ${10}        | ${100000}      | ${'5 is out of range. Expected a value between 10 and 100000.'}
    ${'amount'} | ${100}       | ${0.00001}   | ${86.27382215} | ${'100 is out of range. Expected a value between 0.00001 and 86.27382215.'}
    ${'cost'}   | ${4}         | ${10}        | ${undefined}   | ${'4 is too low. Minimum allowed is 10.'}
    ${'cost'}   | ${2000}      | ${undefined} | ${1000}        | ${'2000 is too high. Maximum allowed is 1000.'}
  `('says its $property with value $said', ({ property, current, min, max, said }) => {
    expect(new OrderOutOfRangeError('exchange', property, current, min, max).message).toBe(
      `[EXCHANGE] Order '${property}' with value ${said}`,
    );
  });

  // The callers round the value to the step of the market before they check it: one rounded to nothing is reported as the order asked
  // for it, with the step and what the market allows. It used to read "value 0 is invalid", the 0.0000099 BTC sent and the step unsaid.
  it.each`
    property    | current    | min          | max          | rounding                                   | said
    ${'amount'} | ${0}       | ${0.00001}   | ${9000}      | ${{ requested: 0.0000099, step: 0.00001 }} | ${'0.0000099 rounds to 0 on the amount step 0.00001 of the market. Expected a value between 0.00001 and 9000.'}
    ${'amount'} | ${0}       | ${1}         | ${undefined} | ${{ requested: 0.4, step: 1 }}             | ${'0.4 rounds to 0 on the amount step 1 of the market. Minimum allowed is 1.'}
    ${'amount'} | ${0}       | ${undefined} | ${9000}      | ${{ requested: 0.0000099, step: 0.00001 }} | ${'0.0000099 rounds to 0 on the amount step 0.00001 of the market. Maximum allowed is 9000.'}
    ${'amount'} | ${0}       | ${undefined} | ${undefined} | ${{ requested: 0.0000099, step: 0.00001 }} | ${'0.0000099 rounds to 0 on the amount step 0.00001 of the market.'}
    ${'amount'} | ${0}       | ${0.00001}   | ${9000}      | ${{ requested: 0.0000099 }}                | ${'0.0000099 rounds to 0 on the amount step of the market. Expected a value between 0.00001 and 9000.'}
    ${'price'}  | ${0}       | ${0.01}      | ${undefined} | ${{ requested: 0.004, step: 0.01 }}        | ${'0.004 rounds to 0 on the price step 0.01 of the market. Minimum allowed is 0.01.'}
    ${'amount'} | ${0}       | ${0.00001}   | ${9000}      | ${{ requested: 0, step: 0.00001 }}         | ${'0 is invalid. Expected a finite number greater than 0.'}
    ${'amount'} | ${0}       | ${0.00001}   | ${9000}      | ${{ requested: NaN, step: 0.00001 }}       | ${'0 is invalid. Expected a finite number greater than 0.'}
    ${'amount'} | ${NaN}     | ${0.00001}   | ${9000}      | ${{ requested: 0.0000099, step: 0.00001 }} | ${'NaN is invalid. Expected a finite number greater than 0.'}
    ${'amount'} | ${0.00001} | ${0.00002}   | ${undefined} | ${{ requested: 0.0000199, step: 0.00001 }} | ${'0.00001 is too low. Minimum allowed is 0.00002.'}
  `('says its $property, rounded from $rounding.requested, with value $said', ({ property, current, min, max, rounding, said }) => {
    expect(new OrderOutOfRangeError('exchange', property, current, min, max, rounding).message).toBe(
      `[EXCHANGE] Order '${property}' with value ${said}`,
    );
  });

  // Every decimal String gives a value, without an exponent: rounded to eight decimals, 0.000099997 would read as the minimum it missed.
  // A value of more than 100 decimals keeps its exponent.
  it.each`
    current              | min           | max          | rounding                           | said
    ${1e-7}              | ${0.00001}    | ${9000}      | ${undefined}                       | ${'0.0000001 is out of range. Expected a value between 0.00001 and 9000.'}
    ${0.000099997}       | ${0.0001}     | ${undefined} | ${undefined}                       | ${'0.000099997 is too low. Minimum allowed is 0.0001.'}
    ${0.00000001}        | ${1.5e-7}     | ${undefined} | ${undefined}                       | ${'0.00000001 is too low. Minimum allowed is 0.00000015.'}
    ${0}                 | ${0.00000001} | ${undefined} | ${{ requested: 4e-9, step: 1e-8 }} | ${'0.000000004 rounds to 0 on the amount step 0.00000001 of the market. Minimum allowed is 0.00000001.'}
    ${5e-324}            | ${0.00000001} | ${undefined} | ${undefined}                       | ${'5e-324 is too low. Minimum allowed is 0.00000001.'}
    ${6.999999999999999} | ${7}          | ${undefined} | ${undefined}                       | ${'6.999999999999999 is too low. Minimum allowed is 7.'}
  `('writes $current as in: with value $said', ({ current, min, max, rounding, said }) => {
    expect(new OrderOutOfRangeError('exchange', 'amount', current, min, max, rounding).message).toBe(
      `[EXCHANGE] Order 'amount' with value ${said}`,
    );
  });

  it('prefixes its message with the tag of its thrower', () => {
    expect(new OrderOutOfRangeError('trader', 'cost', 4, 10).message).toMatch(/^\[TRADER\] /);
  });

  it('is named OrderOutOfRangeError', () => {
    expect(new OrderOutOfRangeError('exchange', 'cost', 4, 10).name).toBe('OrderOutOfRangeError');
  });

  // The orders tell a refusal of the market limits from any other failure by its class, and report it as any GekkoError
  it('is a GekkoError', () => {
    expect(new OrderOutOfRangeError('exchange', 'cost', 4, 10)).toBeInstanceOf(GekkoError);
  });
});
