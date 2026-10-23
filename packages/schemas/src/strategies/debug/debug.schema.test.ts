import { omit } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import { debugAdviceStrategySchema } from './debugAdvice.schema';
import { debugBacktestStrategySchema } from './debugBacktest.schema';
import { debugOrderScriptStrategySchema } from './debugOrderScript.schema';
import { debugPositionBookStrategySchema } from './debugPositionBook.schema';
import { debugRealtimeStrategySchema } from './debugRealtime.schema';
import { debugTrailingStopStrategySchema } from './debugTrailingStop.schema';

// The accepted blocks are copied from the shipped configs and the e2e flows, which run these strategies. The StrategyManager parses a
// block without its name, which only labels the run.
describe('debugAdviceStrategySchema', () => {
  it.each`
    source                                                                | block
    ${'config/realtime-screener.yml and config/realtime-supervision.yml'} | ${{ name: 'DebugAdvice', each: 2, wait: 0 }}
    ${'the paper trader e2e flow'}                                        | ${{ name: 'DebugAdvice', each: 2 }}
    ${'the screener e2e flow'}                                            | ${{ name: 'DebugAdvice', each: 1 }}
    ${'the screener e2e flow, which cancels its orders'}                  | ${{ name: 'DebugAdvice', each: 1, cancelAfter: 1 }}
    ${'the STICKY orders e2e flow'}                                       | ${{ name: 'DebugAdvice', each: 3 }}
    ${'the STICKY orders e2e flow, which cancels its order'}              | ${{ name: 'DebugAdvice', each: 10, cancelAfter: 1 }}
  `('accepts the block of $source', ({ block }) => {
    expect(debugAdviceStrategySchema.safeParse(omit(block, 'name')).success).toBe(true);
  });

  it('defaults wait to 0, the first candle, where a block without it always started', () => {
    expect(debugAdviceStrategySchema.parse({ each: 2 })).toEqual({ each: 2, wait: 0 });
  });

  it.each`
    scenario                          | block                            | code                   | path
    ${'an unknown key (wiat)'}        | ${{ each: 2, wiat: 3 }}          | ${'unrecognized_keys'} | ${[]}
    ${'waittime, which nothing read'} | ${{ each: 2, waittime: 0 }}      | ${'unrecognized_keys'} | ${[]}
    ${'a quoted number'}              | ${{ each: '2' }}                 | ${'invalid_type'}      | ${['each']}
    ${'a block without each'}         | ${{ wait: 0 }}                   | ${'invalid_type'}      | ${['each']}
    ${'each 0, which never advised'}  | ${{ each: 0 }}                   | ${'too_small'}         | ${['each']}
    ${'a fractional each'}            | ${{ each: 2.5 }}                 | ${'invalid_type'}      | ${['each']}
    ${'a negative wait'}              | ${{ each: 2, wait: -1 }}         | ${'too_small'}         | ${['wait']}
    ${'a fractional cancelAfter'}     | ${{ each: 2, cancelAfter: 1.5 }} | ${'invalid_type'}      | ${['cancelAfter']}
  `('refuses $scenario', ({ block, code, path }) => {
    expect(debugAdviceStrategySchema.safeParse(block).error?.issues).toMatchObject([{ code, path }]);
  });
});

describe('debugBacktestStrategySchema', () => {
  it.each`
    source                                                                                     | block
    ${'the backtest e2e flow, scenario A: several trades'}                                     | ${{ name: 'DebugBacktest', buyCandleIndex: [1, 5], sellCandleIndex: [3, 8] }}
    ${'the backtest e2e flow, scenarios B and D, and the reports and database file e2e flows'} | ${{ name: 'DebugBacktest', buyCandleIndex: 1, sellCandleIndex: 3 }}
    ${'the backtest e2e flow, scenario C: a resting LIMIT BUY'}                                | ${{ name: 'DebugBacktest', buyCandleIndex: 2, sellCandleIndex: 14, buyLimitPrice: 9500 }}
    ${'the order sizing e2e flow: two all-in BUYs on one candle'}                              | ${{ name: 'DebugBacktest', buyCandleIndex: 1, sellCandleIndex: 3, allIn: true }}
    ${'the order sizing e2e flow: all-in round trips'}                                         | ${{ name: 'DebugBacktest', buyCandleIndex: [1, 5], sellCandleIndex: [3, 7], allIn: true }}
    ${'the order sizing e2e flow: SELLs alone'}                                                | ${{ name: 'DebugBacktest', buyCandleIndex: [], sellCandleIndex: [1, 2, 3] }}
    ${'the warmup e2e flow: the first candle after the warmup'}                                | ${{ name: 'DebugBacktest', buyCandleIndex: 0, sellCandleIndex: [] }}
    ${'the reports e2e flow: a BUY on every candle'}                                           | ${{ name: 'DebugBacktest', buyCandleIndex: [0, 1, 2, 3, 4, 5, 6], sellCandleIndex: [] }}
    ${'the paper trader e2e flow, scenario C: a resting LIMIT BUY'}                            | ${{ name: 'DebugBacktest', buyCandleIndex: 0, sellCandleIndex: 4, buyLimitPrice: 9500 }}
  `('accepts the block of $source', ({ block }) => {
    expect(debugBacktestStrategySchema.safeParse(omit(block, 'name')).success).toBe(true);
  });

  it.each`
    scenario                             | block                                                      | code                   | path
    ${'an unknown key (buyCandle)'}      | ${{ buyCandleIndex: 2, sellCandleIndex: 4, buyCandle: 3 }} | ${'unrecognized_keys'} | ${[]}
    ${'a quoted index'}                  | ${{ buyCandleIndex: '2', sellCandleIndex: 4 }}             | ${'invalid_union'}     | ${['buyCandleIndex']}
    ${'a block without sellCandleIndex'} | ${{ buyCandleIndex: 2 }}                                   | ${'invalid_union'}     | ${['sellCandleIndex']}
    ${'a negative index'}                | ${{ buyCandleIndex: -1, sellCandleIndex: 4 }}              | ${'too_small'}         | ${['buyCandleIndex']}
    ${'a negative index in a list'}      | ${{ buyCandleIndex: [1, 5], sellCandleIndex: [-1, 7] }}    | ${'too_small'}         | ${['sellCandleIndex', 0]}
    ${'a fractional index'}              | ${{ buyCandleIndex: 2.5, sellCandleIndex: 4 }}             | ${'invalid_union'}     | ${['buyCandleIndex']}
  `('refuses $scenario', ({ block, code, path }) => {
    expect(debugBacktestStrategySchema.safeParse(block).error?.issues).toMatchObject([{ code, path }]);
  });

  it('accepts index 0, the first candle after the warmup, as a candle index or in a list', () => {
    expect(debugBacktestStrategySchema.safeParse({ buyCandleIndex: 0, sellCandleIndex: [0, 3] }).success).toBe(true);
  });

  it('says what an index must be when it is neither a candle index nor a list of them', () => {
    expect(debugBacktestStrategySchema.safeParse({ buyCandleIndex: '2', sellCandleIndex: 4 }).error?.issues[0].message).toBe(
      'Invalid input: expected a candle index (a whole number, 0 for the first candle after the warmup) or a list of them',
    );
  });
});

describe('debugBacktestStrategySchema: cost and allocation', () => {
  /** The block of a backtest that buys on candle 1 and sells on candle 3, its orders sized by `sizing` */
  const sizedBy = (sizing: Record<string, unknown>) => ({ buyCandleIndex: 1, sellCandleIndex: 3, ...sizing });

  // allIn: false is no sizing of its own, the orders of 1 unit a block without allIn sends, which a cost or an allocation replaces
  it.each`
    scenario                                 | sizing
    ${'a cost'}                              | ${{ cost: 200000 }}
    ${'a cost below 1 unit of the currency'} | ${{ cost: 0.5 }}
    ${'an allocation'}                       | ${{ allocation: 50 }}
    ${'an allocation of 100, all-in'}        | ${{ allocation: 100 }}
    ${'an allocation below 1 %'}             | ${{ allocation: 0.5 }}
    ${'allIn false with a cost'}             | ${{ allIn: false, cost: 200000 }}
    ${'allIn false with an allocation'}      | ${{ allIn: false, allocation: 50 }}
  `('accepts $scenario, kept as given', ({ sizing }) => {
    expect(debugBacktestStrategySchema.safeParse(sizedBy(sizing)).data).toEqual(sizedBy(sizing));
  });

  // Bounded as createOrder checks them, which would refuse the first order only once the strategy placed it: above 0 and finite (YAML
  // reads .inf as Infinity), an allocation at most 100, and a number, not a quoted one
  it.each`
    scenario                     | sizing                  | code              | path
    ${'a cost of 0'}             | ${{ cost: 0 }}          | ${'too_small'}    | ${['cost']}
    ${'a negative cost'}         | ${{ cost: -1 }}         | ${'too_small'}    | ${['cost']}
    ${'a quoted cost'}           | ${{ cost: '25' }}       | ${'invalid_type'} | ${['cost']}
    ${'an infinite cost'}        | ${{ cost: Infinity }}   | ${'invalid_type'} | ${['cost']}
    ${'an allocation of 0'}      | ${{ allocation: 0 }}    | ${'too_small'}    | ${['allocation']}
    ${'a negative allocation'}   | ${{ allocation: -1 }}   | ${'too_small'}    | ${['allocation']}
    ${'an allocation above 100'} | ${{ allocation: 101 }}  | ${'too_big'}      | ${['allocation']}
    ${'a quoted allocation'}     | ${{ allocation: '25' }} | ${'invalid_type'} | ${['allocation']}
  `('refuses $scenario', ({ sizing, code, path }) => {
    expect(debugBacktestStrategySchema.safeParse(sizedBy(sizing)).error?.issues).toMatchObject([{ code, path }]);
  });

  // Each sizes every order its own way: given together, the strategy would follow one and drop the others without a word
  it.each`
    scenario                             | sizing                                           | path              | given
    ${'allIn with a cost'}               | ${{ allIn: true, cost: 200000 }}                 | ${['cost']}       | ${'allIn and cost'}
    ${'allIn with an allocation'}        | ${{ allIn: true, allocation: 50 }}               | ${['allocation']} | ${'allIn and allocation'}
    ${'a cost with an allocation'}       | ${{ cost: 200000, allocation: 50 }}              | ${['allocation']} | ${'cost and allocation'}
    ${'allIn, a cost and an allocation'} | ${{ allIn: true, cost: 200000, allocation: 50 }} | ${['cost']}       | ${'allIn, cost and allocation'}
  `('refuses $scenario at the second of them, naming $given', ({ sizing, path, given }) => {
    expect(debugBacktestStrategySchema.safeParse(sizedBy(sizing)).error?.issues).toMatchObject([
      { code: 'custom', path, message: `allIn, cost and allocation size the orders three ways: give at most one, got ${given}` },
    ]);
  });
});

describe('debugOrderScriptStrategySchema', () => {
  const marketBuy = { candle: 0, side: 'BUY', type: 'MARKET' };
  /** A block of one order, a MARKET BUY on candle 0 but for `fields` */
  const orderWith = (fields: Record<string, unknown>) => ({ orders: [{ ...marketBuy, ...fields }] });
  const ROUND_TRIP = {
    name: 'DebugOrderScript',
    orders: [
      { ...marketBuy, amount: 1.0000004 },
      { candle: 1, side: 'SELL', type: 'MARKET' },
    ],
  };
  const CANCELED_LIMIT = { name: 'DebugOrderScript', ...orderWith({ type: 'LIMIT', price: 90.004, cancelAfter: 2 }) };
  it.each`
    source                                                       | block
    ${'the live trader e2e flow, scenario A: a BUY then a SELL'} | ${ROUND_TRIP}
    ${'the live trader e2e flow, scenario B: a LIMIT canceled'}  | ${CANCELED_LIMIT}
  `('accepts the block of $source', ({ block }) => {
    expect(debugOrderScriptStrategySchema.safeParse(omit(block, 'name')).success).toBe(true);
  });

  it('defaults the amount of an order to 1, which the other debug strategies always order', () => {
    expect(debugOrderScriptStrategySchema.parse({ orders: [marketBuy] })).toEqual({ orders: [{ ...marketBuy, amount: 1 }] });
  });

  // cancelAfter 0 would cancel the order on the next candle, as 1 does: the strategy runs the cancellations of a candle before it
  // creates the orders of that candle. Refused, so that a block says what it means.
  it.each`
    scenario                     | block                                     | code                   | path
    ${'an unknown key (cancel)'} | ${{ orders: [marketBuy], cancel: 1 }}     | ${'unrecognized_keys'} | ${[]}
    ${'a block without orders'}  | ${{}}                                     | ${'invalid_type'}      | ${['orders']}
    ${'an empty list of orders'} | ${{ orders: [] }}                         | ${'too_small'}         | ${['orders']}
    ${'an unknown order key'}    | ${orderWith({ quantity: 1 })}             | ${'unrecognized_keys'} | ${['orders', 0]}
    ${'a side in lower case'}    | ${orderWith({ side: 'buy' })}             | ${'invalid_value'}     | ${['orders', 0, 'side']}
    ${'a type Gekko has not'}    | ${orderWith({ type: 'stop_loss' })}       | ${'invalid_value'}     | ${['orders', 0, 'type']}
    ${'a negative candle'}       | ${orderWith({ candle: -1 })}              | ${'too_small'}         | ${['orders', 0, 'candle']}
    ${'a fractional candle'}     | ${orderWith({ candle: 0.5 })}             | ${'invalid_type'}      | ${['orders', 0, 'candle']}
    ${'an amount of 0'}          | ${orderWith({ amount: 0 })}               | ${'too_small'}         | ${['orders', 0, 'amount']}
    ${'a price of 0'}            | ${orderWith({ type: 'LIMIT', price: 0 })} | ${'too_small'}         | ${['orders', 0, 'price']}
    ${'cancelAfter 0'}           | ${orderWith({ cancelAfter: 0 })}          | ${'too_small'}         | ${['orders', 0, 'cancelAfter']}
  `('refuses $scenario', ({ block, code, path }) => {
    expect(debugOrderScriptStrategySchema.safeParse(block).error?.issues).toMatchObject([{ code, path }]);
  });
});

describe('debugPositionBookStrategySchema', () => {
  const BUY_IN_TURN = {
    name: 'DebugPositionBook',
    steps: [
      { candle: 1, side: 'BUY', symbols: ['BTC/USDT', 'ETH/USDT'] },
      { candle: 3, side: 'BUY', symbols: ['SOL/USDT'] },
      { candle: 5, side: 'BUY', symbols: ['XRP/USDT'] },
      { candle: 7, side: 'SELL' },
    ],
  };
  const BUY_ON_THREE_CANDLES = {
    name: 'DebugPositionBook',
    steps: [
      { candle: 1, side: 'BUY' },
      { candle: 2, side: 'BUY' },
      { candle: 3, side: 'BUY' },
    ],
  };
  const SKIPPED_STEPS = {
    name: 'DebugPositionBook',
    steps: [
      { candle: 0, side: 'SELL' },
      { candle: 1, side: 'BUY', symbols: ['BTC/USDT'] },
      { candle: 1, side: 'SELL', symbols: ['BTC/USDT'] },
      { candle: 2, side: 'BUY' },
      { candle: 3, side: 'SELL' },
    ],
  };
  it.each`
    source                                                                        | block
    ${'the position book e2e flow, scenario A: four pairs bought in turn'}        | ${BUY_IN_TURN}
    ${'the position book e2e flow, scenario A: three pairs bought on one candle'} | ${{ name: 'DebugPositionBook', steps: [{ candle: 1, side: 'BUY' }] }}
    ${'the position book e2e flow, scenario B: a BUY of every pair on 3 candles'} | ${BUY_ON_THREE_CANDLES}
    ${'the position book e2e flow, scenario C: the steps the position skips'}     | ${SKIPPED_STEPS}
  `('accepts the block of $source', ({ block }) => {
    expect(debugPositionBookStrategySchema.safeParse(omit(block, 'name')).success).toBe(true);
  });

  it('leaves the symbols out of a step without them, for every watched pair', () => {
    expect(debugPositionBookStrategySchema.parse({ steps: [{ candle: 0, side: 'SELL' }] })).toEqual({
      steps: [{ candle: 0, side: 'SELL' }],
    });
  });

  /** A block of one step, a BUY on candle 0 but for `fields` */
  const stepWith = (fields: Record<string, unknown>) => ({ steps: [{ candle: 0, side: 'BUY', ...fields }] });
  // A symbol is written as the configuration writes one: lower case, or without its slash, it is no watched pair
  it.each`
    scenario                        | block                                  | code                   | path
    ${'an unknown key (step)'}      | ${{ ...stepWith({}), step: [] }}       | ${'unrecognized_keys'} | ${[]}
    ${'a block without steps'}      | ${{}}                                  | ${'invalid_type'}      | ${['steps']}
    ${'an empty list of steps'}     | ${{ steps: [] }}                       | ${'too_small'}         | ${['steps']}
    ${'an unknown step key (pair)'} | ${stepWith({ pair: 'BTC/USDT' })}      | ${'unrecognized_keys'} | ${['steps', 0]}
    ${'a side in lower case'}       | ${stepWith({ side: 'buy' })}           | ${'invalid_value'}     | ${['steps', 0, 'side']}
    ${'a quoted candle'}            | ${stepWith({ candle: '1' })}           | ${'invalid_type'}      | ${['steps', 0, 'candle']}
    ${'a negative candle'}          | ${stepWith({ candle: -1 })}            | ${'too_small'}         | ${['steps', 0, 'candle']}
    ${'a fractional candle'}        | ${stepWith({ candle: 0.5 })}           | ${'invalid_type'}      | ${['steps', 0, 'candle']}
    ${'an empty list of symbols'}   | ${stepWith({ symbols: [] })}           | ${'too_small'}         | ${['steps', 0, 'symbols']}
    ${'a symbol in lower case'}     | ${stepWith({ symbols: ['btc/usdt'] })} | ${'custom'}            | ${['steps', 0, 'symbols', 0]}
    ${'a symbol without its slash'} | ${stepWith({ symbols: ['BTCUSDT'] })}  | ${'custom'}            | ${['steps', 0, 'symbols', 0]}
    ${'a symbol given alone'}       | ${stepWith({ symbols: 'BTC/USDT' })}   | ${'invalid_type'}      | ${['steps', 0, 'symbols']}
  `('refuses $scenario', ({ block, code, path }) => {
    expect(debugPositionBookStrategySchema.safeParse(block).error?.issues).toMatchObject([{ code, path }]);
  });
});

describe('debugRealtimeStrategySchema', () => {
  it.each`
    source                         | block
    ${'the paper trader e2e flow'} | ${{ name: 'DebugRealtime' }}
  `('accepts the block of $source', ({ block }) => {
    expect(debugRealtimeStrategySchema.safeParse(omit(block, 'name')).success).toBe(true);
  });

  it.each`
    scenario                                     | block
    ${'a parameter of DebugAdvice (each)'}       | ${{ each: 2 }}
    ${'a parameter of DebugTrailingStop (wait)'} | ${{ wait: 0 }}
  `('refuses $scenario: it takes no parameter', ({ block }) => {
    expect(debugRealtimeStrategySchema.safeParse(block).error?.issues).toMatchObject([
      { code: 'unrecognized_keys', keys: Object.keys(block), path: [] },
    ]);
  });
});

describe('debugTrailingStopStrategySchema', () => {
  it.each`
    source                         | block
    ${'the paper trader e2e flow'} | ${{ name: 'DebugTrailingStop', wait: 0, trigger: 9930, percentage: 0.1 }}
  `('accepts the block of $source', ({ block }) => {
    expect(debugTrailingStopStrategySchema.safeParse(omit(block, 'name')).success).toBe(true);
  });

  it('defaults wait to 0 and leaves the trigger out, for a stop active as soon as it is armed', () => {
    expect(debugTrailingStopStrategySchema.parse({ percentage: 0.1 })).toEqual({ wait: 0, percentage: 0.1 });
  });

  it.each`
    scenario                          | block                                           | code                   | path
    ${'an unknown key (percent)'}     | ${{ trigger: 9930, percentage: 1, percent: 1 }} | ${'unrecognized_keys'} | ${[]}
    ${'a quoted number'}              | ${{ trigger: 9930, percentage: '1' }}           | ${'invalid_type'}      | ${['percentage']}
    ${'a block without percentage'}   | ${{ trigger: 9930 }}                            | ${'invalid_type'}      | ${['percentage']}
    ${'percentage 0'}                 | ${{ trigger: 9930, percentage: 0 }}             | ${'too_small'}         | ${['percentage']}
    ${'percentage 100'}               | ${{ trigger: 9930, percentage: 100 }}           | ${'too_big'}           | ${['percentage']}
    ${'trigger 0, which is no price'} | ${{ trigger: 0, percentage: 1 }}                | ${'too_small'}         | ${['trigger']}
    ${'a fractional wait'}            | ${{ wait: 0.5, percentage: 1 }}                 | ${'invalid_type'}      | ${['wait']}
  `('refuses $scenario', ({ block, code, path }) => {
    expect(debugTrailingStopStrategySchema.safeParse(block).error?.issues).toMatchObject([{ code, path }]);
  });
});
