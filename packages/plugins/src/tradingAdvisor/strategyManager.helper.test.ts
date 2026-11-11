import { TradingPair } from '@gekko/shared/models/utility.types';
import { indicatorArguments } from '@gekko/strategies/strategy.mock';
import { describe, expect, it } from 'vitest';
import { getPairListProblem, getPositionKeysProblem, getRepeatedPairProblem, indicatorsBySymbol } from './strategyManager.helper';

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

describe('getPairListProblem', () => {
  /** What an untyped strategy is told when it gives track something else than an array of at least one pair */
  const listIssue = (shown: string) =>
    `pairs must be an array of at least one watched pair, or left out to track every watched pair, got ${shown}`;

  // The items are the business of getPairProblem and getRepeatedPairProblem: an array of anything passes here
  it.each`
    given                   | pairs
    ${'one pair'}           | ${[BTC]}
    ${'two pairs'}          | ${[ETH, BTC]}
    ${'a pair named twice'} | ${[BTC, BTC]}
    ${'an item no pair'}    | ${[3]}
  `('lets an array of $given through', ({ pairs }) => {
    expect(getPairListProblem(pairs)).toBeUndefined();
  });

  // Tracking no pair, the strategy would have every order of tools.positions refused from its first signal on
  it.each`
    given                               | pairs                     | shown
    ${'an empty array'}                 | ${[]}                     | ${'[]'}
    ${'a pair alone'}                   | ${BTC}                    | ${"'BTC/USDT'"}
    ${'a Set of pairs'}                 | ${new Set([BTC, ETH])}    | ${"Set(2) { 'BTC/USDT', 'ETH/USDT' }"}
    ${'a Map of the pairs to booleans'} | ${new Map([[BTC, true]])} | ${"Map(1) { 'BTC/USDT' => true }"}
    ${'an object'}                      | ${{ pairs: [BTC] }}       | ${"{ pairs: [ 'BTC/USDT' ] }"}
    ${'a number'}                       | ${2}                      | ${'2'}
  `('refuses $given, showing it as util.inspect does: $shown', ({ pairs, shown }) => {
    expect(getPairListProblem(pairs)).toBe(listIssue(shown));
  });
});

describe('getRepeatedPairProblem', () => {
  it.each`
    given                    | pairs
    ${'one pair'}            | ${[BTC]}
    ${'two pairs'}           | ${[BTC, ETH]}
    ${'two pairs, reversed'} | ${[ETH, BTC]}
  `('lets $given, each named once, through', ({ pairs }) => {
    expect(getRepeatedPairProblem(pairs)).toBeUndefined();
  });

  // The first pair named again, wherever its first mention
  it.each`
    given                                 | pairs                   | repeated
    ${'a pair named twice in a row'}      | ${[BTC, BTC]}           | ${BTC}
    ${'a pair named again after another'} | ${[ETH, BTC, ETH]}      | ${ETH}
    ${'two pairs each named twice'}       | ${[BTC, ETH, ETH, BTC]} | ${ETH}
  `('refuses $given, naming the first repeat: $repeated', ({ pairs, repeated }) => {
    expect(getRepeatedPairProblem(pairs)).toBe(`pairs must name each watched pair once, got '${repeated}' twice`);
  });
});

describe('getPositionKeysProblem', () => {
  /** The keys each side takes, as the refusal lists them */
  const BUY_KEYS = "'symbol', 'type', 'price', 'trailing'";
  const SELL_KEYS = "'symbol', 'type', 'price'";
  /** Where an order is sized otherwise, as the refusal of a size says it */
  const ELSEWHERE = '(tools.createOrder takes an amount, a cost or an allocation)';

  it.each`
    side      | order
    ${'BUY'}  | ${{ symbol: BTC, type: 'MARKET' }}
    ${'BUY'}  | ${{ symbol: BTC, type: 'LIMIT', price: 100, trailing: { percentage: 2 } }}
    ${'SELL'} | ${{ symbol: BTC, type: 'MARKET' }}
    ${'SELL'} | ${{ symbol: BTC, type: 'LIMIT', price: 100 }}
  `('lets a $side holding no key but those it takes through: $order', ({ side, order }) => {
    expect(getPositionKeysProblem(order, side)).toBeUndefined();
  });

  // Whatever their values, undefined included, as createOrder refuses a key it does not take. The book sizes its orders: a size given
  // is told where an order is sized so, any other key is shown beside the keys taken
  it.each`
    side      | problem                                      | order                                                           | expected
    ${'BUY'}  | ${'an amount'}                               | ${{ symbol: BTC, type: 'MARKET', amount: 1 }}                   | ${`tools.positions.buy takes no key but ${BUY_KEYS}, got 'amount': the position book sizes the order ${ELSEWHERE}`}
    ${'BUY'}  | ${'a cost'}                                  | ${{ symbol: BTC, type: 'MARKET', cost: 100 }}                   | ${`tools.positions.buy takes no key but ${BUY_KEYS}, got 'cost': the position book sizes the order ${ELSEWHERE}`}
    ${'BUY'}  | ${'an allocation left undefined'}            | ${{ symbol: BTC, type: 'MARKET', allocation: undefined }}       | ${`tools.positions.buy takes no key but ${BUY_KEYS}, got 'allocation': the position book sizes the order ${ELSEWHERE}`}
    ${'BUY'}  | ${'a side'}                                  | ${{ symbol: BTC, side: 'BUY', type: 'MARKET' }}                 | ${`tools.positions.buy takes no key but ${BUY_KEYS}, got 'side'`}
    ${'BUY'}  | ${'a price spelt prise'}                     | ${{ symbol: BTC, type: 'LIMIT', prise: 100 }}                   | ${`tools.positions.buy takes no key but ${BUY_KEYS}, got 'prise'`}
    ${'BUY'}  | ${'a side and an amount, a size among them'} | ${{ symbol: BTC, side: 'BUY', type: 'MARKET', amount: 1 }}      | ${`tools.positions.buy takes no key but ${BUY_KEYS}, got 'side', 'amount': the position book sizes the order ${ELSEWHERE}`}
    ${'SELL'} | ${'an amount'}                               | ${{ symbol: BTC, type: 'MARKET', amount: 1 }}                   | ${`tools.positions.sell takes no key but ${SELL_KEYS}, got 'amount': it sells all of the asset free ${ELSEWHERE}`}
    ${'SELL'} | ${'an allocation'}                           | ${{ symbol: BTC, type: 'MARKET', allocation: 50 }}              | ${`tools.positions.sell takes no key but ${SELL_KEYS}, got 'allocation': it sells all of the asset free ${ELSEWHERE}`}
    ${'SELL'} | ${'a trailing stop'}                         | ${{ symbol: BTC, type: 'MARKET', trailing: { percentage: 2 } }} | ${`tools.positions.sell takes no key but ${SELL_KEYS}, got 'trailing'`}
  `('refuses a $side holding $problem', ({ side, order, expected }) => {
    expect(getPositionKeysProblem(order, side)).toBe(expected);
  });
});
