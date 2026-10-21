import { round } from '@utils/math/round.utils';
import { describe, expect, it } from 'vitest';
import { getAllInBuyAmount, getAllocatedShare, getBuyBudget, getSellAmountOfCost } from './sizing.helper';

describe('sizing.helper', () => {
  // The currency an all-in BUY of that amount is sized from at that price: what it buys is 95 % of it, the 5 % left kept back for the
  // fee. In binary, the cost of the last two comes out an ulp off (114.99999999999999 and 7.000000000000001), and so does their budget.
  describe('getBuyBudget', () => {
    it.each`
      amount     | price  | budget
      ${9.5}     | ${100} | ${1000}
      ${4.75}    | ${100} | ${500}
      ${2}       | ${95}  | ${200}
      ${0.00095} | ${100} | ${0.1}
      ${1.15}    | ${100} | ${121.05263157894737}
      ${0.07}    | ${100} | ${7.36842105263158}
    `('is $budget for a BUY of $amount at $price', ({ amount, price, budget }) => {
      expect(getBuyBudget(amount, price)).toBe(budget);
    });
  });

  // 95 % of the currency at the price, 473.6842105263157 USDT being what a BUY of 5 at 100 leaves of 1000 (see getBuyBudget). In
  // binary, (currency / price) * 0.95 came out an ulp short of the first three (5.699999999999999, 7.598099999999999 and
  // 4.499999999999999). The exact product divided in binary still gave 4.499999999999999 for the third, and 1614.9999999999998 for the
  // fourth. A quotient that does not end is given to 15 significant digits, and NaN stays NaN, for the exchange to refuse.
  describe('getAllInBuyAmount', () => {
    it.each`
      currency             | price       | amount
      ${600}               | ${100}      | ${5.7}
      ${799.8}             | ${100}      | ${7.5981}
      ${473.6842105263157} | ${100}      | ${4.5}
      ${17}                | ${0.01}     | ${1615}
      ${1000}              | ${3}        | ${316.666666666667}
      ${1000}              | ${100}      | ${9.5}
      ${0}                 | ${100}      | ${0}
      ${1000}              | ${Infinity} | ${0}
      ${NaN}               | ${100}      | ${NaN}
    `('is $amount for $currency at $price', ({ currency, price, amount }) => {
      expect(getAllInBuyAmount(currency, price)).toBe(amount);
    });

    // Truncated to the step of the market, as ccxt and the simulated exchange place an amount: an ulp short of a whole number of steps,
    // the amount was placed one step short (5.69999 BTC)
    it.each`
      currency             | price   | decimals | placed
      ${600}               | ${100}  | ${5}     | ${5.7}
      ${799.8}             | ${100}  | ${8}     | ${7.5981}
      ${473.6842105263157} | ${100}  | ${5}     | ${4.5}
      ${17}                | ${0.01} | ${2}     | ${1615}
      ${1000}              | ${3}    | ${5}     | ${316.66666}
    `('is placed as $placed for $currency at $price on a step of $decimals decimals', ({ currency, price, decimals, placed }) => {
      expect(round(getAllInBuyAmount(currency, price), decimals, 'down')).toBe(placed);
    });
  });

  // The percentage moved two places, then the product of the decimals: in binary, 33.3 % of 3 came out at 0.9989999999999999, and 10 %
  // of 0.7 and of 2.2, as 0.7 × 0.1 and 2.2 × 0.1, at 0.06999999999999999 and 0.22000000000000003
  describe('getAllocatedShare', () => {
    it.each`
      balance    | allocation | share
      ${1000}    | ${25}      | ${250}
      ${1000}    | ${100}     | ${1000}
      ${1000.01} | ${100}     | ${1000.01}
      ${1000}    | ${0.5}     | ${5}
      ${1000}    | ${33.33}   | ${333.3}
      ${3}       | ${33.3}    | ${0.999}
      ${0.7}     | ${10}      | ${0.07}
      ${2.2}     | ${10}      | ${0.22}
      ${0.7992}  | ${50}      | ${0.3996}
      ${0}       | ${50}      | ${0}
    `('is $share for $allocation % of $balance', ({ balance, allocation, share }) => {
      expect(getAllocatedShare(balance, allocation)).toBe(share);
    });

    // Truncated to the step of the market, as ccxt and the simulated exchange place an amount: an ulp short of a whole number of steps,
    // the amount was placed one step short (0.998)
    it.each`
      balance | allocation | decimals | placed
      ${3}    | ${33.3}    | ${3}     | ${0.999}
      ${0.7}  | ${10}      | ${2}     | ${0.07}
    `('is placed as $placed for $allocation % of $balance on a step of $decimals decimals', ({ balance, allocation, decimals, placed }) => {
      expect(round(getAllocatedShare(balance, allocation), decimals, 'down')).toBe(placed);
    });
  });

  // The one division to 15 significant digits: in binary, 0.3 at 0.1 came out at 2.9999999999999996 and 0.7 at 0.1 at
  // 6.999999999999999. Infinity, which only the Trader's tests reach, sizes nothing.
  describe('getSellAmountOfCost', () => {
    it.each`
      cost    | price       | amount
      ${100}  | ${100}      | ${1}
      ${0.3}  | ${0.1}      | ${3}
      ${0.7}  | ${0.1}      | ${7}
      ${100}  | ${97.3}     | ${1.02774922918808}
      ${1000} | ${3}        | ${333.333333333333}
      ${5}    | ${100}      | ${0.05}
      ${100}  | ${Infinity} | ${0}
    `('is $amount for a cost of $cost at $price', ({ cost, price, amount }) => {
      expect(getSellAmountOfCost(cost, price)).toBe(amount);
    });
  });
});
