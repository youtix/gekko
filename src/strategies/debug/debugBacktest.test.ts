import type { TradingPair } from '@models/utility.types';
import { OrderRecorder } from '@strategies/positionTracker.mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { playCandles, toolsOf } from './debug.mock';
import { debugBacktestStrategySchema } from './debugBacktest.schema';
import { DebugBacktest } from './debugBacktest.strategy';
import { DebugBacktestParams } from './debugBacktest.types';

const BTC: TradingPair = 'BTC/USDT';
const ETH: TradingPair = 'ETH/USDT';

describe('DebugBacktest', () => {
  let strategy: DebugBacktest;
  let orders: OrderRecorder;

  /** Plays `count` candles of `pairs` with the strategy block parsed as `params`: see playCandles */
  const play = (count: number, params: DebugBacktestParams, pairs: TradingPair[] = [BTC]) => {
    return playCandles(strategy, toolsOf(params, { createOrder: orders.createOrder }), orders, count, pairs);
  };

  beforeEach(() => {
    strategy = new DebugBacktest();
    orders = new OrderRecorder();
  });

  // Counted from 1, the first candle after the warmup was index 1: buyCandleIndex 0 never bought
  it.each`
    buy       | sell      | calendar
    ${0}      | ${3}      | ${'B . . S .'}
    ${1}      | ${4}      | ${'. B . . S'}
    ${[1, 5]} | ${[3, 7]} | ${'. B . S . B . S .'}
    ${[0, 2]} | ${[]}     | ${'B . B .'}
    ${2}      | ${2}      | ${'. . BS .'}
  `('orders on the candles listed, counted from 0, the first after the warmup: buy $buy, sell $sell', ({ buy, sell, calendar }) => {
    expect(play(calendar.split(' ').length, { buyCandleIndex: buy, sellCandleIndex: sell })).toBe(calendar);
  });

  it('sends a MARKET order of 1 unit, for a PnL known to the unit', () => {
    play(2, { buyCandleIndex: 0, sellCandleIndex: 1 });
    expect(orders.advices).toStrictEqual([
      { type: 'MARKET', side: 'BUY', amount: 1, symbol: BTC },
      { type: 'MARKET', side: 'SELL', amount: 1, symbol: BTC },
    ]);
  });

  it('sends its BUYs as LIMIT orders at buyLimitPrice when it is set, its SELLs as MARKET orders', () => {
    play(2, { buyCandleIndex: 0, sellCandleIndex: 1, buyLimitPrice: 9500 });
    expect(orders.advices).toStrictEqual([
      { type: 'LIMIT', side: 'BUY', amount: 1, price: 9500, symbol: BTC },
      { type: 'MARKET', side: 'SELL', amount: 1, symbol: BTC },
    ]);
  });

  // An order the Trader sizes has no amount key at all, not one set to undefined, as a built-in strategy creates its all-in orders: an
  // all-in order holds no sizing key, an order by cost or by allocation that key alone
  it.each`
    scenario                                                           | options                                    | buy                                                                         | sell
    ${'with allIn, a MARKET BUY and a MARKET SELL without amount'}     | ${{ allIn: true }}                         | ${{ type: 'MARKET', side: 'BUY', symbol: BTC }}                             | ${{ type: 'MARKET', side: 'SELL', symbol: BTC }}
    ${'with allIn and buyLimitPrice, a LIMIT BUY without amount'}      | ${{ allIn: true, buyLimitPrice: 9500 }}    | ${{ type: 'LIMIT', side: 'BUY', price: 9500, symbol: BTC }}                 | ${{ type: 'MARKET', side: 'SELL', symbol: BTC }}
    ${'with allIn false, orders of 1 unit as without it'}              | ${{ allIn: false }}                        | ${{ type: 'MARKET', side: 'BUY', amount: 1, symbol: BTC }}                  | ${{ type: 'MARKET', side: 'SELL', amount: 1, symbol: BTC }}
    ${'with cost, a MARKET BUY and a MARKET SELL of that cost'}        | ${{ cost: 200000 }}                        | ${{ type: 'MARKET', side: 'BUY', cost: 200000, symbol: BTC }}               | ${{ type: 'MARKET', side: 'SELL', cost: 200000, symbol: BTC }}
    ${'with cost and buyLimitPrice, a LIMIT BUY of that cost'}         | ${{ cost: 200000, buyLimitPrice: 9500 }}   | ${{ type: 'LIMIT', side: 'BUY', cost: 200000, price: 9500, symbol: BTC }}   | ${{ type: 'MARKET', side: 'SELL', cost: 200000, symbol: BTC }}
    ${'with allIn false and cost, orders of that cost'}                | ${{ allIn: false, cost: 200000 }}          | ${{ type: 'MARKET', side: 'BUY', cost: 200000, symbol: BTC }}               | ${{ type: 'MARKET', side: 'SELL', cost: 200000, symbol: BTC }}
    ${'with allocation, a MARKET BUY and a MARKET SELL of that share'} | ${{ allocation: 50 }}                      | ${{ type: 'MARKET', side: 'BUY', allocation: 50, symbol: BTC }}             | ${{ type: 'MARKET', side: 'SELL', allocation: 50, symbol: BTC }}
    ${'with allocation and buyLimitPrice, a LIMIT BUY of that share'}  | ${{ allocation: 50, buyLimitPrice: 9500 }} | ${{ type: 'LIMIT', side: 'BUY', allocation: 50, price: 9500, symbol: BTC }} | ${{ type: 'MARKET', side: 'SELL', allocation: 50, symbol: BTC }}
    ${'with allIn false and allocation, orders of that share'}         | ${{ allIn: false, allocation: 50 }}        | ${{ type: 'MARKET', side: 'BUY', allocation: 50, symbol: BTC }}             | ${{ type: 'MARKET', side: 'SELL', allocation: 50, symbol: BTC }}
  `('sends $scenario', ({ options, buy, sell }) => {
    play(2, { buyCandleIndex: 0, sellCandleIndex: 1, ...options });
    expect(orders.advices).toStrictEqual([buy, sell]);
  });

  // Each pair's BUY carries the share, which the Trader takes of the currency it read: two pairs at 50 % both buy on one candle, where
  // the all-in BUY of the first left the second nothing
  it('sends every order of every watched pair with the allocation', () => {
    play(2, { buyCandleIndex: 0, sellCandleIndex: 1, allocation: 50 }, [BTC, ETH]);
    expect(orders.advices).toStrictEqual([
      { type: 'MARKET', side: 'BUY', allocation: 50, symbol: BTC },
      { type: 'MARKET', side: 'BUY', allocation: 50, symbol: ETH },
      { type: 'MARKET', side: 'SELL', allocation: 50, symbol: BTC },
      { type: 'MARKET', side: 'SELL', allocation: 50, symbol: ETH },
    ]);
  });

  it('orders on every watched pair', () => {
    play(2, { buyCandleIndex: 0, sellCandleIndex: 1 }, [BTC, ETH]);
    expect(orders.advices.map(({ side, symbol }) => `${side} ${symbol}`)).toEqual([
      'BUY BTC/USDT',
      'BUY ETH/USDT',
      'SELL BTC/USDT',
      'SELL ETH/USDT',
    ]);
  });
});

describe('debugBacktestStrategySchema: buyLimitPrice', () => {
  it('leaves buyLimitPrice out of a block without it, for MARKET BUYs', () => {
    expect(debugBacktestStrategySchema.parse({ buyCandleIndex: 1, sellCandleIndex: 3 })).toEqual({ buyCandleIndex: 1, sellCandleIndex: 3 });
  });

  it.each`
    scenario              | buyLimitPrice | code
    ${'a price of 0'}     | ${0}          | ${'too_small'}
    ${'a negative price'} | ${-9500}      | ${'too_small'}
    ${'a quoted price'}   | ${'9500'}     | ${'invalid_type'}
  `('refuses $scenario, which no LIMIT order can rest at', ({ buyLimitPrice, code }) => {
    expect(debugBacktestStrategySchema.safeParse({ buyCandleIndex: 1, sellCandleIndex: 3, buyLimitPrice }).error?.issues).toMatchObject([
      { code, path: ['buyLimitPrice'] },
    ]);
  });
});

describe('debugBacktestStrategySchema: allIn', () => {
  it('leaves allIn out of a block without it, for orders of 1 unit', () => {
    expect(debugBacktestStrategySchema.parse({ buyCandleIndex: 1, sellCandleIndex: 3 })).not.toHaveProperty('allIn');
  });

  // A quoted boolean is no boolean: 'false' would read as true
  it.each`
    scenario              | allIn
    ${'a quoted boolean'} | ${'false'}
    ${'a number'}         | ${1}
  `('refuses $scenario', ({ allIn }) => {
    expect(debugBacktestStrategySchema.safeParse({ buyCandleIndex: 1, sellCandleIndex: 3, allIn }).error?.issues).toMatchObject([
      { code: 'invalid_type', path: ['allIn'] },
    ]);
  });
});
