import { OrderOutOfRangeError } from '@errors/orderOutOfRange.error';
import { MarketData } from '@services/exchange/exchange.types';
import { omit } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import { assertOrderWithinLimits, checkOrderPrice, getMarketOrderLimits } from './market.utils';

describe('Market Utils', () => {
  const marketData: MarketData = {
    price: { min: 10, max: 100 },
    amount: { min: 1, max: 10 },
    cost: { min: 10, max: 1000 },
  };
  // A Binance market as ccxt parses it when its PRICE_FILTER disables maxPrice with 0, the value ccxt copies into price.max
  const binanceMarketData: MarketData = {
    price: { min: 0.01, max: 0 },
    amount: { min: 0.00001, max: 9000 },
    cost: { min: 5, max: 9000000 },
  };
  // The same market with Binance's BTC/USDT steps, a price to the cent and an amount to 5 decimals, which the callers round to
  const steppedMarketData: MarketData = { ...binanceMarketData, precision: { price: 0.01, amount: 0.00001 } };

  describe('checkOrderPrice', () => {
    it.each`
      price   | data                                             | description
      ${50}   | ${marketData}                                    | ${'a price within the limits'}
      ${10}   | ${marketData}                                    | ${'the minimum price'}
      ${100}  | ${marketData}                                    | ${'the maximum price'}
      ${50}   | ${{}}                                            | ${'no limits'}
      ${5}    | ${{ price: { min: undefined, max: undefined } }} | ${'undefined limits'}
      ${1e9}  | ${{ price: { min: 0.01, max: 0 } }}              | ${'a max of 0, which sets no maximum (Binance PRICE_FILTER)'}
      ${1e9}  | ${{ price: { min: 0.01, max: -1 } }}             | ${'a negative max, which sets no maximum'}
      ${1e9}  | ${{ price: { min: 0.01, max: NaN } }}            | ${'a NaN max, which sets no maximum'}
      ${1e-9} | ${{ price: { min: 0, max: 100 } }}               | ${'a min of 0, which sets no minimum'}
      ${1e-9} | ${{ price: { min: -1, max: 100 } }}              | ${'a negative min, which sets no minimum'}
      ${1e-9} | ${{ price: { min: NaN, max: 100 } }}             | ${'a NaN min, which sets no minimum'}
    `('accepts a price of $price given $description', ({ price, data }) => {
      expect(checkOrderPrice(price, data)).toEqual({ isValid: true, value: price });
    });

    // The bounds reported are those the check reads: a limit that is not a finite number above 0 is none
    it.each`
      price       | data                                     | min          | max          | description
      ${9}        | ${marketData}                            | ${10}        | ${100}       | ${'below the minimum'}
      ${101}      | ${marketData}                            | ${10}        | ${100}       | ${'above the maximum'}
      ${9}        | ${{ price: { min: 10 } }}                | ${10}        | ${undefined} | ${'below a minimum without maximum'}
      ${11}       | ${{ price: { max: 10 } }}                | ${undefined} | ${10}        | ${'above a maximum without minimum'}
      ${NaN}      | ${marketData}                            | ${10}        | ${100}       | ${'NaN, with limits'}
      ${NaN}      | ${{}}                                    | ${undefined} | ${undefined} | ${'NaN, without limits'}
      ${Infinity} | ${marketData}                            | ${10}        | ${100}       | ${'infinite, with limits'}
      ${Infinity} | ${{}}                                    | ${undefined} | ${undefined} | ${'infinite, without limits'}
      ${-1}       | ${marketData}                            | ${10}        | ${100}       | ${'negative, with limits'}
      ${-1}       | ${{}}                                    | ${undefined} | ${undefined} | ${'negative, without limits'}
      ${0}        | ${marketData}                            | ${10}        | ${100}       | ${'zero, with limits'}
      ${0}        | ${{}}                                    | ${undefined} | ${undefined} | ${'zero, without limits'}
      ${0}        | ${{ price: { min: 0 } }}                 | ${undefined} | ${undefined} | ${'zero, with a min of 0 reported as no minimum'}
      ${5}        | ${{ price: { min: 10, max: 0 } }}        | ${10}        | ${undefined} | ${'below the minimum, with a max of 0 reported as no maximum'}
      ${5}        | ${{ price: { min: 10, max: NaN } }}      | ${10}        | ${undefined} | ${'below the minimum, with a NaN max reported as no maximum'}
      ${5}        | ${{ price: { min: 10, max: Infinity } }} | ${10}        | ${undefined} | ${'below the minimum, with an infinite max reported as no maximum'}
    `('refuses a price of $price $description, with the bounds $min and $max', ({ price, data, min, max }) => {
      expect(checkOrderPrice(price, data)).toEqual({ isValid: false, reason: 'price', value: price, min, max });
    });
  });

  describe('getMarketOrderLimits', () => {
    // BTCUSDT as ccxt parses it from Binance: LOT_SIZE (amount) up to 9000 BTC, MARKET_LOT_SIZE (market) from 0, no minimum, to 86.27382215
    const binanceMarketOrderData: MarketData = { ...binanceMarketData, market: { min: 0, max: 86.27382215 } };

    it.each`
      amount                         | market                                | narrowed                              | description
      ${{ min: 1, max: 10 }}         | ${undefined}                          | ${{ min: 1, max: 10 }}                | ${'no market range'}
      ${{ min: 1, max: 10 }}         | ${{ min: 0.5, max: 5 }}               | ${{ min: 1, max: 5 }}                 | ${'a lower market maximum'}
      ${{ min: 1, max: 10 }}         | ${{ min: 2, max: 50 }}                | ${{ min: 2, max: 10 }}                | ${'a higher market minimum'}
      ${{ min: 1, max: 10 }}         | ${{ min: 2, max: 5 }}                 | ${{ min: 2, max: 5 }}                 | ${'a market range within the amount range'}
      ${{ min: 0.00001, max: 9000 }} | ${{ min: 0, max: 86.27382215 }}       | ${{ min: 0.00001, max: 86.27382215 }} | ${'a market minimum of 0, which sets no minimum (Binance MARKET_LOT_SIZE)'}
      ${{ min: 1, max: 0 }}          | ${{ min: -1, max: 5 }}                | ${{ min: 1, max: 5 }}                 | ${'an amount maximum of 0 and a negative market minimum, which set nothing'}
      ${{ min: 0, max: 0 }}          | ${{ min: 0, max: 0 }}                 | ${{ min: undefined, max: undefined }} | ${'bounds of 0 only, which set nothing'}
      ${{ min: 1, max: 10 }}         | ${{ min: NaN, max: Infinity }}        | ${{ min: 1, max: 10 }}                | ${'a NaN market minimum and an infinite market maximum, which set nothing'}
      ${undefined}                   | ${{ min: 2, max: 5 }}                 | ${{ min: 2, max: 5 }}                 | ${'no amount range'}
      ${{ min: 1, max: 10 }}         | ${{ min: undefined, max: undefined }} | ${{ min: 1, max: 10 }}                | ${'a market range without bounds, as getMarketData gives it for Hyperliquid'}
    `('narrows the amount range to the tighter bounds for $description', ({ amount, market, narrowed }) => {
      expect(getMarketOrderLimits({ amount, market }).amount).toEqual(narrowed);
    });

    it('leaves the price and the cost limits as they are', () => {
      expect(getMarketOrderLimits(binanceMarketOrderData)).toMatchObject({
        price: binanceMarketData.price,
        cost: binanceMarketData.cost,
      });
    });

    // The limits Binance applies to a market order: 100 BTC passes LOT_SIZE, but not MARKET_LOT_SIZE
    it('makes assertOrderWithinLimits refuse an amount above the market maximum, naming the narrowed range', () => {
      const limits = getMarketOrderLimits(binanceMarketOrderData);
      expect(() => assertOrderWithinLimits({ tag: 'exchange', amount: 100, price: 60000, marketData: limits })).toThrow(
        new OrderOutOfRangeError('exchange', 'amount', 100, 0.00001, 86.27382215),
      );
    });
  });

  describe('assertOrderWithinLimits', () => {
    // The cost is worked out in decimal, as the exchange works it out. In binary, an order costing exactly a bound of the market came
    // out an ulp past it, and was refused: 0.00007 × 100000 is 6.999999999999999, 0.00001 × 300000 is 3.0000000000000004
    it.each`
      amount     | price       | data                         | cost      | description
      ${2}       | ${50}       | ${marketData}                | ${100}    | ${'an order within the market limits'}
      ${1}       | ${10}       | ${marketData}                | ${10}     | ${'an order on every minimum'}
      ${10}      | ${100}      | ${marketData}                | ${1000}   | ${'an order on every maximum'}
      ${2}       | ${50}       | ${{}}                        | ${100}    | ${'an order on a market without limits'}
      ${0.001}   | ${60000}    | ${binanceMarketData}         | ${60}     | ${'an order on a Binance market, whose max price of 0 sets no maximum'}
      ${0.1}     | ${0.7}      | ${{}}                        | ${0.07}   | ${'an order costing 0.07, 0.06999999999999999 in binary'}
      ${0.00007} | ${100000}   | ${{ cost: { min: 7 } }}      | ${7}      | ${'an order costing exactly the minimum of 7'}
      ${100}     | ${0.000001} | ${{ cost: { min: 0.0001 } }} | ${0.0001} | ${'100 DOGE at 0.000001 BTC, exactly the minimum of 0.0001, 0.00009999999999999999 in binary'}
      ${25}      | ${0.000004} | ${{ cost: { min: 0.0001 } }} | ${0.0001} | ${'25 DOGE at 0.000004 BTC, exactly the minimum of 0.0001'}
      ${0.00001} | ${300000}   | ${{ cost: { max: 3 } }}      | ${3}      | ${'an order costing exactly the maximum of 3'}
    `('returns $amount at $price, costing $cost, for $description', ({ amount, price, data, cost }) => {
      expect(assertOrderWithinLimits({ tag: 'exchange', amount, price, marketData: data })).toEqual({ amount, price, cost });
    });

    // The price, then the amount, then the cost, each against its own limits, and the bounds reported as the check reads them: a limit
    // that is not a finite number above 0 is none. The cost refused is the decimal one.
    it.each`
      amount        | price     | data                                    | reason      | value       | min          | max          | description
      ${2}          | ${NaN}    | ${marketData}                           | ${'price'}  | ${NaN}      | ${10}        | ${100}       | ${'a NaN price'}
      ${NaN}        | ${NaN}    | ${marketData}                           | ${'price'}  | ${NaN}      | ${10}        | ${100}       | ${'a NaN price and a NaN amount, the price checked first'}
      ${2}          | ${5}      | ${marketData}                           | ${'price'}  | ${5}        | ${10}        | ${100}       | ${'a price below the market minimum'}
      ${11}         | ${101}    | ${marketData}                           | ${'price'}  | ${101}      | ${10}        | ${100}       | ${'a price above its maximum and an amount above its own, the price checked first'}
      ${0.001}      | ${0.001}  | ${binanceMarketData}                    | ${'price'}  | ${0.001}    | ${0.01}      | ${undefined} | ${'a price below the minimum of a Binance market, whose max price of 0 is no maximum'}
      ${NaN}        | ${50}     | ${marketData}                           | ${'amount'} | ${NaN}      | ${1}         | ${10}        | ${'a NaN amount'}
      ${Infinity}   | ${50}     | ${marketData}                           | ${'amount'} | ${Infinity} | ${1}         | ${10}        | ${'an infinite amount'}
      ${0}          | ${50}     | ${{}}                                   | ${'amount'} | ${0}        | ${undefined} | ${undefined} | ${'a zero amount without limits'}
      ${-1}         | ${50}     | ${{ amount: { max: 10 } }}              | ${'amount'} | ${-1}       | ${undefined} | ${10}        | ${'a negative amount with only a maximum'}
      ${0.5}        | ${50}     | ${marketData}                           | ${'amount'} | ${0.5}      | ${1}         | ${10}        | ${'an amount below the market minimum'}
      ${11}         | ${50}     | ${marketData}                           | ${'amount'} | ${11}       | ${1}         | ${10}        | ${'an amount above the market maximum, its cost of 550 within its own limits'}
      ${0.5}        | ${50}     | ${{ amount: { min: 1, max: 0 } }}       | ${'amount'} | ${0.5}      | ${1}         | ${undefined} | ${'an amount below the minimum, with a max of 0 reported as no maximum'}
      ${11}         | ${50}     | ${{ amount: { min: -1, max: 10 } }}     | ${'amount'} | ${11}       | ${undefined} | ${10}        | ${'an amount above the maximum, with a negative min reported as no minimum'}
      ${2}          | ${2}      | ${{ cost: { min: 10 } }}                | ${'cost'}   | ${4}        | ${10}        | ${undefined} | ${'a cost below a minimum without maximum'}
      ${20}         | ${100}    | ${{ cost: { max: 1000 } }}              | ${'cost'}   | ${2000}     | ${undefined} | ${1000}      | ${'a cost above a maximum without minimum'}
      ${50}         | ${21}     | ${{ cost: { min: 10, max: 1000 } }}     | ${'cost'}   | ${1050}     | ${10}        | ${1000}      | ${'a cost above the maximum of a range'}
      ${1e200}      | ${1e200}  | ${{}}                                   | ${'cost'}   | ${Infinity} | ${undefined} | ${undefined} | ${'a cost overflowing to Infinity'}
      ${1e-200}     | ${1e-200} | ${{}}                                   | ${'cost'}   | ${0}        | ${undefined} | ${undefined} | ${'a cost underflowing to 0'}
      ${0.1}        | ${0.7}    | ${{ cost: { min: 1 } }}                 | ${'cost'}   | ${0.07}     | ${1}         | ${undefined} | ${'a cost of 0.07, 0.06999999999999999 in binary'}
      ${0.00006999} | ${100000} | ${{ cost: { min: 7 } }}                 | ${'cost'}   | ${6.999}    | ${7}         | ${undefined} | ${'a cost of 6.999, under the minimum of 7'}
      ${0.00001001} | ${300000} | ${{ cost: { max: 3 } }}                 | ${'cost'}   | ${3.003}    | ${undefined} | ${3}         | ${'a cost of 3.003, over the maximum of 3'}
      ${1}          | ${5}      | ${{ cost: { min: 10, max: 0 } }}        | ${'cost'}   | ${5}        | ${10}        | ${undefined} | ${'a cost below the minimum, with a max of 0 reported as no maximum'}
      ${1}          | ${5}      | ${{ cost: { min: 10, max: NaN } }}      | ${'cost'}   | ${5}        | ${10}        | ${undefined} | ${'a cost below the minimum, with a NaN max reported as no maximum'}
      ${1}          | ${5}      | ${{ cost: { min: 10, max: Infinity } }} | ${'cost'}   | ${5}        | ${10}        | ${undefined} | ${'a cost below the minimum, with an infinite max reported as no maximum'}
    `('refuses $description: its $reason of $value', ({ amount, price, data, reason, value, min, max }) => {
      expect(() => assertOrderWithinLimits({ tag: 'exchange', amount, price, marketData: data })).toThrow(
        new OrderOutOfRangeError('exchange', reason, value, min, max),
      );
    });

    // The callers round the amount and the price to the steps of the market before they check them: given what the order asked for,
    // a value rounded to nothing is refused as asked, with the step that rounded it. A cost is never rounded.
    it.each`
      amount     | price    | data                                                  | requested                                 | reason      | value      | min        | max          | rounding                                   | description
      ${0}       | ${100}   | ${steppedMarketData}                                  | ${{ amount: 0.0000099, price: 100 }}      | ${'amount'} | ${0}       | ${0.00001} | ${9000}      | ${{ requested: 0.0000099, step: 0.00001 }} | ${'an amount the step truncated to 0'}
      ${1}       | ${0}     | ${steppedMarketData}                                  | ${{ amount: 1, price: 0.004 }}            | ${'price'}  | ${0}       | ${0.01}    | ${undefined} | ${{ requested: 0.004, step: 0.01 }}        | ${'a price the tick rounded to 0'}
      ${0}       | ${100}   | ${omit(steppedMarketData, 'precision')}               | ${{ amount: 0.0000099, price: 100 }}      | ${'amount'} | ${0}       | ${0.00001} | ${9000}      | ${{ requested: 0.0000099 }}                | ${'an amount rounded to 0 on a market that states no step'}
      ${0}       | ${100}   | ${{ ...steppedMarketData, precision: { amount: 0 } }} | ${{ amount: 0.0000099, price: 100 }}      | ${'amount'} | ${0}       | ${0.00001} | ${9000}      | ${{ requested: 0.0000099 }}                | ${'an amount rounded to 0 on a market whose step of 0 is none'}
      ${0.00001} | ${100}   | ${{ ...steppedMarketData, amount: { min: 0.00002 } }} | ${{ amount: 0.0000199, price: 100 }}      | ${'amount'} | ${0.00001} | ${0.00002} | ${undefined} | ${{ requested: 0.0000199, step: 0.00001 }} | ${'an amount truncated under the minimum'}
      ${0.00005} | ${99990} | ${steppedMarketData}                                  | ${{ amount: 0.0000560556, price: 99990 }} | ${'cost'}   | ${4.9995}  | ${5}       | ${9000000}   | ${undefined}                               | ${'a cost under the minimum once the amount is truncated'}
    `('refuses $description as the order asked for it: its $reason of $value', ({ amount, price, data, requested, reason, ...error }) => {
      expect(() => assertOrderWithinLimits({ tag: 'exchange', amount, price, marketData: data, requested })).toThrow(
        new OrderOutOfRangeError('exchange', reason, error.value, error.min, error.max, error.rounding),
      );
    });

    it('throws an OrderOutOfRangeError', () => {
      expect(() => assertOrderWithinLimits({ tag: 'exchange', amount: NaN, price: 50, marketData })).toThrow(OrderOutOfRangeError);
    });

    it('prefixes the error message with the given tag', () => {
      expect(() => assertOrderWithinLimits({ tag: 'trader', amount: NaN, price: 50, marketData })).toThrow('[TRADER] ');
    });
  });
});
