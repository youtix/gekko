import { omit } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import { demaStrategySchema } from './dema.schema';
import { FRACTIONAL_NUMBER, INFINITE_NUMBER, misspeltIssues, missing, NAN_NUMBER, QUOTED_NUMBER, unknownKey } from './strategySchema.mock';

// The example of the guide (documentation/built-in-strategies.md), which the realtime configurations of config/ and the quick start use,
// without the name that labels the run: the StrategyManager parses the block without it
const params = { period: 12, thresholds: { up: 100, down: -150 } };
const withThresholds = (thresholds: Record<string, unknown>) => ({ ...params, thresholds: { ...params.thresholds, ...thresholds } });

const PERIOD_MESSAGE = 'period must be at least 2 (the DEMA and the SMA of a single candle are both its close, so they never differ)';

describe('demaStrategySchema', () => {
  // No parameter has a default: the block reaches the strategy as it is written
  it.each`
    scenario                                                                 | block
    ${'the example of the guide and of the realtime configurations'}         | ${params}
    ${'a period of 2, the smallest'}                                         | ${{ ...params, period: 2 }}
    ${'thresholds in fractions of the price, for a pair priced a few units'} | ${{ period: 21, thresholds: { up: 0.0025, down: -0.0025 } }}
    ${'thresholds the wrong way round, which nothing checks'}                | ${withThresholds({ up: -150, down: 100 })}
  `('accepts $scenario as it is', ({ block }) => {
    expect(demaStrategySchema.parse(block)).toEqual(block);
  });

  // Unchecked, a misspelt thresholds block (tresholds) threw a TypeError at the first candle with the DEMA ready, hours into a realtime
  // run
  it.each`
    scenario                                     | block                                                              | issues
    ${'a misspelt thresholds block (tresholds)'} | ${{ ...omit(params, 'thresholds'), tresholds: params.thresholds }} | ${misspeltIssues(['thresholds'], 'tresholds', 'object')}
    ${'a misspelt threshold (dwon)'}             | ${{ ...params, thresholds: { up: 100, dwon: -150 } }}              | ${misspeltIssues(['thresholds', 'down'], 'dwon')}
  `('refuses $scenario, naming the parameter missing and the key unknown', ({ block, issues }) => {
    expect(demaStrategySchema.safeParse(block).error?.issues).toMatchObject(issues);
  });

  it.each`
    scenario                                                  | block                                 | path                      | message
    ${'a src, which the DEMA strategy does not take'}         | ${{ ...params, src: 'close' }}        | ${[]}                     | ${unknownKey('src')}
    ${'a persistence, which the DEMA strategy does not take'} | ${withThresholds({ persistence: 1 })} | ${['thresholds']}         | ${unknownKey('persistence')}
    ${'a missing period'}                                     | ${omit(params, 'period')}             | ${['period']}             | ${missing('number')}
    ${'a quoted period'}                                      | ${{ ...params, period: '12' }}        | ${['period']}             | ${QUOTED_NUMBER}
    ${'a fractional period'}                                  | ${{ ...params, period: 12.5 }}        | ${['period']}             | ${FRACTIONAL_NUMBER}
    ${'a period of 1, whose DEMA and SMA never differ'}       | ${{ ...params, period: 1 }}           | ${['period']}             | ${PERIOD_MESSAGE}
    ${'a period of 0'}                                        | ${{ ...params, period: 0 }}           | ${['period']}             | ${PERIOD_MESSAGE}
    ${'a missing thresholds block'}                           | ${omit(params, 'thresholds')}         | ${['thresholds']}         | ${missing('object')}
    ${'a quoted threshold'}                                   | ${withThresholds({ up: '100' })}      | ${['thresholds', 'up']}   | ${QUOTED_NUMBER}
    ${'an infinite threshold'}                                | ${withThresholds({ up: Infinity })}   | ${['thresholds', 'up']}   | ${INFINITE_NUMBER}
    ${'a NaN threshold'}                                      | ${withThresholds({ down: NaN })}      | ${['thresholds', 'down']} | ${NAN_NUMBER}
  `('refuses $scenario', ({ block, path, message }) => {
    expect(demaStrategySchema.safeParse(block).error?.issues).toMatchObject([{ path, message }]);
  });
});
