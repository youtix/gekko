import { describe, expect, it } from 'vitest';
import { debugAdviceStrategySchema } from '@gekko/schemas/strategies/debug/debugAdvice.schema';
import { DebugAdvice } from './debugAdvice.strategy';
import { debugBacktestStrategySchema } from '@gekko/schemas/strategies/debug/debugBacktest.schema';
import { DebugBacktest } from './debugBacktest.strategy';
import { debugOrderScriptStrategySchema } from '@gekko/schemas/strategies/debug/debugOrderScript.schema';
import { DebugOrderScript } from './debugOrderScript.strategy';
import { debugPositionBookStrategySchema } from '@gekko/schemas/strategies/debug/debugPositionBook.schema';
import { DebugPositionBook } from './debugPositionBook.strategy';
import { debugRealtimeStrategySchema } from '@gekko/schemas/strategies/debug/debugRealtime.schema';
import { DebugRealtime } from './debugRealtime.strategy';
import { debugTrailingStopStrategySchema } from '@gekko/schemas/strategies/debug/debugTrailingStop.schema';
import { DebugTrailingStop } from './debugTrailingStop.strategy';

// A class without its schema still runs, its block unchecked: nothing else would notice the schema gone
describe('the debug strategies', () => {
  it.each`
    name                   | strategy             | schema
    ${'DebugAdvice'}       | ${DebugAdvice}       | ${debugAdviceStrategySchema}
    ${'DebugBacktest'}     | ${DebugBacktest}     | ${debugBacktestStrategySchema}
    ${'DebugOrderScript'}  | ${DebugOrderScript}  | ${debugOrderScriptStrategySchema}
    ${'DebugPositionBook'} | ${DebugPositionBook} | ${debugPositionBookStrategySchema}
    ${'DebugRealtime'}     | ${DebugRealtime}     | ${debugRealtimeStrategySchema}
    ${'DebugTrailingStop'} | ${DebugTrailingStop} | ${debugTrailingStopStrategySchema}
  `('$name declares the schema its strategy block is parsed with', ({ strategy, schema }) => {
    expect(strategy.schema).toBe(schema);
  });
});
