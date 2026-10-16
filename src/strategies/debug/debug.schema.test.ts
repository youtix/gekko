import { omit } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import { debugAdviceStrategySchema } from './debugAdvice.schema';
import { DebugAdvice } from './debugAdvice.strategy';
import { debugBacktestStrategySchema } from './debugBacktest.schema';
import { DebugBacktest } from './debugBacktest.strategy';
import { debugRealtimeStrategySchema } from './debugRealtime.schema';
import { DebugRealtime } from './debugRealtime.strategy';
import { debugTrailingStopStrategySchema } from './debugTrailingStop.schema';
import { DebugTrailingStop } from './debugTrailingStop.strategy';

// A class without its schema still runs, its block unchecked: nothing else would notice the schema gone
describe('the debug strategies', () => {
  it.each`
    name                   | strategy             | schema
    ${'DebugAdvice'}       | ${DebugAdvice}       | ${debugAdviceStrategySchema}
    ${'DebugBacktest'}     | ${DebugBacktest}     | ${debugBacktestStrategySchema}
    ${'DebugRealtime'}     | ${DebugRealtime}     | ${debugRealtimeStrategySchema}
    ${'DebugTrailingStop'} | ${DebugTrailingStop} | ${debugTrailingStopStrategySchema}
  `('$name declares the schema its strategy block is parsed with', ({ strategy, schema }) => {
    expect(strategy.schema).toBe(schema);
  });
});

// The accepted blocks are copied from the shipped configs and the e2e flows, which run these strategies. The StrategyManager parses a
// block without its name, which only labels the run.
describe('debugAdviceStrategySchema', () => {
  it.each`
    source                                                                | block
    ${'config/realtime-screener.yml and config/realtime-supervision.yml'} | ${{ name: 'DebugAdvice', each: 2, wait: 0 }}
    ${'the paper trader e2e flow'}                                        | ${{ name: 'DebugAdvice', each: 2 }}
    ${'the screener e2e flow'}                                            | ${{ name: 'DebugAdvice', each: 1 }}
    ${'the screener e2e flow, which cancels its orders'}                  | ${{ name: 'DebugAdvice', each: 1, cancelAfter: 1 }}
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
    source                                                      | block
    ${'the backtest e2e flow, scenario A: several trades'}      | ${{ name: 'DebugBacktest', buyCandleIndex: [1, 5], sellCandleIndex: [3, 8] }}
    ${'the backtest e2e flow, scenarios B and D'}               | ${{ name: 'DebugBacktest', buyCandleIndex: 1, sellCandleIndex: 3 }}
    ${'the backtest e2e flow, scenario C: a resting LIMIT BUY'} | ${{ name: 'DebugBacktest', buyCandleIndex: 2, sellCandleIndex: 14, buyLimitPrice: 9500 }}
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
