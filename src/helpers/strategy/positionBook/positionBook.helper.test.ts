import { MarketData } from '@services/exchange/exchange.types';
import { describe, expect, it } from 'vitest';
import { getBuyRefusal } from './positionBook.helper';

const STEP = { precision: { amount: 0.00001 } } satisfies MarketData;

describe('positionBook.helper', () => {
  describe('getBuyRefusal', () => {
    // A budget of 6 USDT keeps back 5 % for the fee: 5.7 USDT, what the BUY can cost at most, before the step
    it.each`
      case                                                                          | order                                 | budget | close       | marketData                                                      | expected
      ${'a market without a minimum'}                                               | ${{ type: 'STICKY' }}                 | ${1}   | ${97654.32} | ${STEP}                                                         | ${undefined}
      ${'no market data'}                                                           | ${{ type: 'STICKY' }}                 | ${1}   | ${97654.32} | ${undefined}                                                    | ${undefined}
      ${'5.7 USDT before the step, below a minimum cost of 6'}                      | ${{ type: 'STICKY' }}                 | ${6}   | ${97654.32} | ${{ ...STEP, cost: { min: 6 } }}                                | ${'5.7 USDT once 5 % is kept back for the fee, is below the minimum cost of 6 USDT of the market'}
      ${'5.7 USDT before the step, the minimum cost itself, and on the step'}       | ${{ type: 'STICKY' }}                 | ${6}   | ${95000}    | ${{ ...STEP, cost: { min: 5.7 } }}                              | ${undefined}
      ${'0.00005 BTC at 97654.32 on the step, 4.882716 USDT, below 5'}              | ${{ type: 'STICKY' }}                 | ${6}   | ${97654.32} | ${{ ...STEP, cost: { min: 5 } }}                                | ${'5.7 USDT once 5 % is kept back for the fee, 0.00005 BTC at 97654.32 once truncated to the amount step 0.00001 of the market, a cost of 4.882716 USDT, is below the minimum cost of 5 USDT of the market'}
      ${'0.00007 BTC at 100000 on the step, 7 USDT in decimal, the minimum itself'} | ${{ type: 'STICKY' }}                 | ${7.4} | ${100000}   | ${{ ...STEP, cost: { min: 7 } }}                                | ${undefined}
      ${'0.00057 BTC at 10000, below a minimum amount of 0.001'}                    | ${{ type: 'STICKY' }}                 | ${6}   | ${10000}    | ${{ ...STEP, amount: { min: 0.001 } }}                          | ${'5.7 USDT once 5 % is kept back for the fee, 0.00057 BTC at 10000 once truncated to the amount step 0.00001 of the market, is below the minimum amount of 0.001 BTC of the market'}
      ${'0.00057 BTC at 10000, the minimum amount itself'}                          | ${{ type: 'STICKY' }}                 | ${6}   | ${10000}    | ${{ ...STEP, amount: { min: 0.00057 } }}                        | ${undefined}
      ${'nothing to buy with, below a minimum amount alone'}                        | ${{ type: 'STICKY' }}                 | ${0}   | ${10000}    | ${{ amount: { min: 0.001 } }}                                   | ${'0 USDT once 5 % is kept back for the fee, 0 BTC at 10000, is below the minimum amount of 0.001 BTC of the market'}
      ${'a MARKET BUY below the minimum of a market order'}                         | ${{ type: 'MARKET' }}                 | ${6}   | ${10000}    | ${{ ...STEP, amount: { min: 0.0001 }, market: { min: 0.001 } }} | ${'5.7 USDT once 5 % is kept back for the fee, 0.00057 BTC at 10000 once truncated to the amount step 0.00001 of the market, is below the minimum amount of 0.001 BTC of the market'}
      ${'a LIMIT BUY, which the minimum of a market order does not bound'}          | ${{ type: 'LIMIT', price: 10000 }}    | ${6}   | ${10000}    | ${{ ...STEP, amount: { min: 0.0001 }, market: { min: 0.001 } }} | ${undefined}
      ${'a LIMIT BUY at its price, not at the close'}                               | ${{ type: 'LIMIT', price: 97654.32 }} | ${6}   | ${95000}    | ${{ ...STEP, cost: { min: 5 } }}                                | ${'5.7 USDT once 5 % is kept back for the fee, 0.00005 BTC at 97654.32 once truncated to the amount step 0.00001 of the market, a cost of 4.882716 USDT, is below the minimum cost of 5 USDT of the market'}
    `('says why the market would refuse a BUY of BTC/USDT: $case', ({ order, budget, close, marketData, expected }) => {
      expect(getBuyRefusal({ ...order, symbol: 'BTC/USDT' }, budget, close, marketData)).toBe(expected);
    });

    // Neither the close nor the price of the order: the Trader refuses such a BUY for its price, before any amount is worked out
    it.each`
      close
      ${undefined}
      ${NaN}
      ${0}
      ${-1}
      ${Infinity}
    `('works out no amount without a price above 0: a close of $close', ({ close }) => {
      expect(getBuyRefusal({ type: 'STICKY', symbol: 'BTC/USDT' }, 6, close, { ...STEP, cost: { min: 5 } })).toBeUndefined();
    });
  });
});
