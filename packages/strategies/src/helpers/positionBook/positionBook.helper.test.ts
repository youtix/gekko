import { MarketData } from '@gekko/shared/models/exchange.types';
import { describe, expect, it } from 'vitest';
import { describeShare, getBuyRefusal, isSameRead } from './positionBook.helper';

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

  describe('describeShare', () => {
    // A part held is named only for a share: an all-in BUY is sized from what is left of the currency free
    it.each`
      case                                     | allocation   | free         | held         | expected
      ${'all-in'}                              | ${undefined} | ${9}         | ${0}         | ${'all of the 9 USDT free'}
      ${'all-in, beside a part held'}          | ${undefined} | ${15.75}     | ${14.25}     | ${'all of the 15.75 USDT free'}
      ${'a share, nothing held'}               | ${50}        | ${20}        | ${0}         | ${'50 % of the 20 USDT free'}
      ${'a share, a part held'}                | ${50}        | ${15.75}     | ${14.25}     | ${'50 % of 30 USDT: 15.75 USDT free at the last synchronization, plus 14.25 USDT held by the BUYs open then'}
      ${'a share of 0.3 + 0.1, in decimal'}    | ${25}        | ${0.3}       | ${0.1}       | ${'25 % of 0.4 USDT: 0.3 USDT free at the last synchronization, plus 0.1 USDT held by the BUYs open then'}
      ${'a share, every decimal'}              | ${50}        | ${0.0000005} | ${0.0000002} | ${'50 % of 0.0000007 USDT: 0.0000005 USDT free at the last synchronization, plus 0.0000002 USDT held by the BUYs open then'}
      ${'a share, a part held that is no sum'} | ${50}        | ${20}        | ${NaN}       | ${'50 % of the 20 USDT free'}
    `('names the currency of $case: $expected', ({ allocation, free, held, expected }) => {
      expect(describeShare(allocation, free, held, 'USDT')).toBe(expected);
    });
  });

  describe('isSameRead', () => {
    // A read taken after a BUY reached the exchange shows it: the currency it reserves moved from free to used, or spent on its fills
    it.each`
      case                                    | read                      | other                           | expected
      ${'the same currency free and held'}    | ${{ free: 30, used: 0 }}  | ${{ free: 30, used: 0 }}        | ${true}
      ${'a BUY reserving 14.25 since'}        | ${{ free: 30, used: 0 }}  | ${{ free: 15.75, used: 14.25 }} | ${false}
      ${'a BUY filled since, nothing held'}   | ${{ free: 30, used: 0 }}  | ${{ free: 15.75, used: 0 }}     | ${false}
      ${'the same currency free, more held'}  | ${{ free: 20, used: 10 }} | ${{ free: 20, used: 12 }}       | ${false}
      ${'0 and -0, one amount'}               | ${{ free: 0, used: 0 }}   | ${{ free: -0, used: -0 }}       | ${true}
      ${'a currency free of NaN, read twice'} | ${{ free: NaN, used: 0 }} | ${{ free: NaN, used: 0 }}       | ${true}
    `('says whether two balances of the currency are one read, $case: $expected', ({ read, other, expected }) => {
      expect(isSameRead(read, other)).toBe(expected);
    });
  });
});
