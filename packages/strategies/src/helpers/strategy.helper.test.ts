import { indicatorArguments } from './positionBook/positionBook.mock';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { describe, expect, it } from 'vitest';
import { indicatorsBySymbol } from './strategy.helper';

const BTC: TradingPair = 'BTC/USDT';
const ETH: TradingPair = 'ETH/USDT';
/** The indicator argument of `symbol` holding `results` */
const on = (symbol: TradingPair, results: unknown) => ({ results, symbol });

describe('indicatorsBySymbol', () => {
  // The arguments of a hook, in the order of the addIndicator calls; the groups read as entries, so that their order is asserted too
  it.each`
    case                               | indicators                                                        | expected
    ${'no indicator'}                  | ${[]}                                                             | ${[]}
    ${'one pair'}                      | ${[on(BTC, 1), on(BTC, 2)]}                                       | ${[[BTC, [on(BTC, 1), on(BTC, 2)]]]}
    ${'two pairs, added pair by pair'} | ${indicatorArguments({ 'BTC/USDT': [1, 2], 'ETH/USDT': [3, 4] })} | ${[[BTC, [on(BTC, 1), on(BTC, 2)]], [ETH, [on(ETH, 3), on(ETH, 4)]]]}
    ${'two pairs, interleaved'}        | ${[on(ETH, 3), on(BTC, 1), on(ETH, 4), on(BTC, 2)]}               | ${[[ETH, [on(ETH, 3), on(ETH, 4)]], [BTC, [on(BTC, 1), on(BTC, 2)]]]}
  `('groups the indicators of $case by pair, the pairs in the order met, each in the order of its calls', ({ indicators, expected }) => {
    expect([...indicatorsBySymbol(indicators)]).toEqual(expected);
  });

  // The hooks get the strategy's own copy of the results: grouped, they are not copied again on every candle
  it('groups the arguments themselves', () => {
    const indicators = [on(BTC, { macd: 1, signal: 0, hist: 1 })];
    expect(indicatorsBySymbol(indicators).get(BTC)?.[0]).toBe(indicators[0]);
  });
});
