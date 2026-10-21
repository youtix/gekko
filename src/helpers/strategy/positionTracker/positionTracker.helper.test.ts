import { Portfolio } from '@models/portfolio.types';
import { TradingPair } from '@models/utility.types';
import { MarketData } from '@services/exchange/exchange.types';
import { describe, expect, it } from 'vitest';
import { coversAmountAsked, getHolding, isSellable, pickTradedPair } from './positionTracker.helper';
import { ETH_IGNORED_WARNING, holding, LoggedLine } from './positionTracker.mock';
import { UnfinishedOrderParams } from './positionTracker.types';

const THREE_PAIRS_WARNING =
  'The strategy trades ETH/USDT only, the first pair watched (watch.assets): it ignores BTC/USDT, SOL/USDT, whose candles are still required every minute';

// The rule the tracker reads a position with, exported for whoever checks an all-in SELL the same way (a trailing stop's)
describe('isSellable', () => {
  const limits: MarketData = { amount: { min: 0.001 }, cost: { min: 5 }, market: { min: 0.2 }, precision: { amount: 0.0001 } };
  // A minimum whose binary product with an amount worth it exactly falls an ulp under it: 0.00007 × 100000 is 6.999999999999999
  const minimumOfSeven: MarketData = { cost: { min: 7 }, precision: { amount: 0.00001 } };
  // A step that is not one unit of a decimal, which CCXTExchange truncates to as to any other: 1.4 is sent as 1. Only a power of ten was
  // truncated to, and 1.4 read as sellable over a minimum of 1.1
  const halfStep: MarketData = { amount: { min: 1.1 }, precision: { amount: 0.5 } };
  it.each`
    amount     | price     | type        | data              | description                                                        | expected
    ${0.1}     | ${100}    | ${'LIMIT'}  | ${limits}         | ${'0.1 at 100, 10 USDT'}                                           | ${true}
    ${0.1}     | ${100}    | ${'MARKET'} | ${limits}         | ${'0.1 in a MARKET order, under its minimum of 0.2'}               | ${false}
    ${0.04999} | ${100}    | ${'LIMIT'}  | ${limits}         | ${'0.04999 at 100, 4.999 USDT, under the minimum cost'}            | ${false}
    ${0.05009} | ${100}    | ${'LIMIT'}  | ${limits}         | ${'0.05009, sent as 0.05: 5 USDT, the minimum cost itself'}        | ${true}
    ${0.0005}  | ${0}      | ${'LIMIT'}  | ${limits}         | ${'0.0005 at an unknown price, under the minimum amount'}          | ${false}
    ${0.01}    | ${0}      | ${'LIMIT'}  | ${limits}         | ${'0.01 at an unknown price, the cost unchecked'}                  | ${true}
    ${0}       | ${100}    | ${'LIMIT'}  | ${{}}             | ${'nothing, on a market without limits'}                           | ${false}
    ${0.00007} | ${100000} | ${'LIMIT'}  | ${minimumOfSeven} | ${'0.00007 at 100000, 7 USDT in decimal, the minimum cost itself'} | ${true}
    ${0.00006} | ${100000} | ${'LIMIT'}  | ${minimumOfSeven} | ${'0.00006 at 100000, 6 USDT, under the minimum cost'}             | ${false}
    ${1.4}     | ${10}     | ${'LIMIT'}  | ${halfStep}       | ${'1.4 on a step of 0.5, sent as 1, under the minimum of 1.1'}     | ${false}
    ${1.6}     | ${10}     | ${'LIMIT'}  | ${halfStep}       | ${'1.6 on a step of 0.5, sent as 1.5, over the minimum of 1.1'}    | ${true}
  `('is $expected for $description', ({ amount, price, type, data, expected }) => {
    expect(isSellable(amount, price, type, data)).toBe(expected);
  });
});

describe('coversAmountAsked', () => {
  it.each`
    case                                                                       | asked        | amount | expected
    ${'a SELL of 2 placed, or sold, for 2'}                                    | ${2}         | ${2}   | ${true}
    ${'a SELL of 2 capped at 1'}                                               | ${2}         | ${1}   | ${false}
    ${'a SELL without an amount: all-in, by a cost or an allocation, adopted'} | ${undefined} | ${1}   | ${false}
  `('is $expected for $case', ({ asked, amount, expected }) => {
    expect(coversAmountAsked(asked, amount)).toBe(expected);
  });
});

describe('getHolding', () => {
  const symbol = 'BTC/USDT';
  const notRead: Portfolio = new Map();

  /** What the event of the outcome of an order of BTC/USDT placed for `amount` carries that getHolding reads: the portfolio after it */
  const outcomeOf = (amount: number, portfolio: Portfolio) =>
    ({ order: { symbol, amount }, exchange: { portfolio, price: 100 } }) as unknown as UnfinishedOrderParams;

  // The all-in SELLs of 1 left 0.5 unsold, which the cancelation released: a portfolio that shows less was read before it, or never
  it.each`
    case                                                         | pending                        | amount | fill                               | portfolio               | held   | fact
    ${'a BUY that filled 0.9, 5 BTC free'}                       | ${{ side: 'BUY' }}             | ${1}   | ${{ filled: 0.9, remaining: 0.1 }} | ${holding(symbol, 5)}   | ${0.9} | ${'filled'}
    ${'a SELL of 2 sent for 2, 0.5 left unsold, 3 BTC free'}     | ${{ side: 'SELL', amount: 2 }} | ${2}   | ${{ filled: 1.5, remaining: 0.5 }} | ${holding(symbol, 3)}   | ${0.5} | ${'left unsold'}
    ${'a SELL of 2 sent for 1, 0.5 left unsold, 1.5 BTC free'}   | ${{ side: 'SELL', amount: 2 }} | ${1}   | ${{ filled: 0.5, remaining: 0.5 }} | ${holding(symbol, 1.5)} | ${1.5} | ${'free in the portfolio after it'}
    ${'an all-in SELL, 0.5 left unsold, 0.7 BTC free'}           | ${{ side: 'SELL' }}            | ${1}   | ${{ filled: 0.5, remaining: 0.5 }} | ${holding(symbol, 0.7)} | ${0.7} | ${'free in the portfolio after it'}
    ${'an all-in SELL, 0.5 left unsold, as much BTC free'}       | ${{ side: 'SELL' }}            | ${1}   | ${{ filled: 0.5, remaining: 0.5 }} | ${holding(symbol, 0.5)} | ${0.5} | ${'left unsold'}
    ${'an all-in SELL, 0.5 left unsold, 0.2 BTC free'}           | ${{ side: 'SELL' }}            | ${1}   | ${{ filled: 0.5, remaining: 0.5 }} | ${holding(symbol, 0.2)} | ${0.5} | ${'left unsold'}
    ${'an all-in SELL, 0.5 left unsold, the portfolio not read'} | ${{ side: 'SELL' }}            | ${1}   | ${{ filled: 0.5, remaining: 0.5 }} | ${notRead}              | ${0.5} | ${'left unsold'}
    ${'a BUY without a fill, 0.4 BTC free'}                      | ${{ side: 'BUY' }}             | ${1}   | ${undefined}                       | ${holding(symbol, 0.4)} | ${0.4} | ${'free in the portfolio after it'}
    ${'a SELL of 2 without a fill, 0.3 BTC free'}                | ${{ side: 'SELL', amount: 2 }} | ${2}   | ${undefined}                       | ${holding(symbol, 0.3)} | ${0.3} | ${'free in the portfolio after it'}
  `('reads $held BTC $fact after $case', ({ pending, amount, fill, portfolio, held, fact }) => {
    expect(getHolding(pending, outcomeOf(amount, portfolio), fill)).toEqual({ held, fact });
  });

  it.each`
    side
    ${'BUY'}
    ${'SELL'}
  `('knows nothing held after a $side without a fill, the portfolio not read', ({ side }) => {
    expect(getHolding({ side }, outcomeOf(1, notRead))).toBeUndefined();
  });
});

describe('pickTradedPair', () => {
  /** Picks the pair of a bucket holding a candle of each of `pairs`, in that order; returns it with the lines it logged */
  const pickPair = (pairs: TradingPair[]) => {
    const logs: LoggedLine[] = [];
    const candle = new Map(pairs.map(pair => [pair, { start: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 }]));
    const pair = pickTradedPair(candle, { log: (level, message) => logs.push({ level, message }) });
    return { pair, logs };
  };

  // The bucket holds a candle of every watched pair, in the order of watch.assets
  it.each`
    case             | pairs                                   | expected
    ${'one pair'}    | ${['BTC/USDT']}                         | ${'BTC/USDT'}
    ${'two pairs'}   | ${['BTC/USDT', 'ETH/USDT']}             | ${'BTC/USDT'}
    ${'three pairs'} | ${['ETH/USDT', 'BTC/USDT', 'SOL/USDT']} | ${'ETH/USDT'}
  `('trades the first pair of the bucket: $case', ({ pairs, expected }) => {
    expect(pickPair(pairs).pair).toBe(expected);
  });

  it.each`
    case             | pairs                                   | expected
    ${'one pair'}    | ${['BTC/USDT']}                         | ${[]}
    ${'two pairs'}   | ${['BTC/USDT', 'ETH/USDT']}             | ${[ETH_IGNORED_WARNING]}
    ${'three pairs'} | ${['ETH/USDT', 'BTC/USDT', 'SOL/USDT']} | ${[{ level: 'warn', message: THREE_PAIRS_WARNING }]}
  `('warns once that it ignores the other pairs: $case', ({ pairs, expected }) => {
    expect(pickPair(pairs).logs).toEqual(expected);
  });
});
