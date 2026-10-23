import { omit } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import { cciStrategySchema } from './cci.schema';
import {
  AT_LEAST_ZERO,
  FRACTIONAL_NUMBER,
  INFINITE_NUMBER,
  misspeltIssues,
  missing,
  NAN_NUMBER,
  QUOTED_NUMBER,
  unknownKey,
} from './strategySchema.mock';

// The example of the guide (documentation/built-in-strategies.md), without the name that labels the run: the StrategyManager parses the
// block without it
const params = { period: 20, thresholds: { up: 100, down: -100, persistence: 0 } };
const withThresholds = (thresholds: Record<string, unknown>) => ({ ...params, thresholds: { ...params.thresholds, ...thresholds } });

const PERIOD_MESSAGE = 'period must be at least 2 (the CCI of a single candle is always 0)';

describe('cciStrategySchema', () => {
  // No parameter has a default: the block reaches the strategy as it is written
  it.each`
    scenario                                                  | block
    ${'the example of the guide'}                             | ${params}
    ${'a period of 2, the smallest'}                          | ${{ ...params, period: 2 }}
    ${'a persistence of 3, three candles in a row'}           | ${withThresholds({ persistence: 3 })}
    ${'thresholds the wrong way round, which nothing checks'} | ${withThresholds({ up: -100, down: 100 })}
  `('accepts $scenario as it is', ({ block }) => {
    expect(cciStrategySchema.parse(block)).toEqual(block);
  });

  // Unchecked, a misspelt persistence (persistance) left it undefined, and the strategy never traded
  it.each`
    scenario                                     | block                                                                 | issues
    ${'a misspelt persistence (persistance)'}    | ${{ ...params, thresholds: { up: 100, down: -100, persistance: 0 } }} | ${misspeltIssues(['thresholds', 'persistence'], 'persistance')}
    ${'a misspelt thresholds block (threshold)'} | ${{ ...omit(params, 'thresholds'), threshold: params.thresholds }}    | ${misspeltIssues(['thresholds'], 'threshold', 'object')}
  `('refuses $scenario, naming the parameter missing and the key unknown', ({ block, issues }) => {
    expect(cciStrategySchema.safeParse(block).error?.issues).toMatchObject(issues);
  });

  it.each`
    scenario                                  | block                                                         | path                             | message
    ${'a src, which the CCI does not take'}   | ${{ ...params, src: 'close' }}                                | ${[]}                            | ${unknownKey('src')}
    ${'a threshold of the RSI (high)'}        | ${withThresholds({ high: 70 })}                               | ${['thresholds']}                | ${unknownKey('high')}
    ${'a missing period'}                     | ${omit(params, 'period')}                                     | ${['period']}                    | ${missing('number')}
    ${'a quoted period'}                      | ${{ ...params, period: '20' }}                                | ${['period']}                    | ${QUOTED_NUMBER}
    ${'a fractional period'}                  | ${{ ...params, period: 20.5 }}                                | ${['period']}                    | ${FRACTIONAL_NUMBER}
    ${'a period of 1, whose CCI is always 0'} | ${{ ...params, period: 1 }}                                   | ${['period']}                    | ${PERIOD_MESSAGE}
    ${'a period of 0'}                        | ${{ ...params, period: 0 }}                                   | ${['period']}                    | ${PERIOD_MESSAGE}
    ${'a missing thresholds block'}           | ${omit(params, 'thresholds')}                                 | ${['thresholds']}                | ${missing('object')}
    ${'a missing threshold'}                  | ${{ ...params, thresholds: omit(params.thresholds, 'down') }} | ${['thresholds', 'down']}        | ${missing('number')}
    ${'a quoted threshold'}                   | ${withThresholds({ up: '100' })}                              | ${['thresholds', 'up']}          | ${QUOTED_NUMBER}
    ${'an infinite threshold'}                | ${withThresholds({ down: -Infinity })}                        | ${['thresholds', 'down']}        | ${INFINITE_NUMBER}
    ${'a NaN threshold'}                      | ${withThresholds({ up: NaN })}                                | ${['thresholds', 'up']}          | ${NAN_NUMBER}
    ${'a negative persistence'}               | ${withThresholds({ persistence: -1 })}                        | ${['thresholds', 'persistence']} | ${AT_LEAST_ZERO}
    ${'a fractional persistence'}             | ${withThresholds({ persistence: 1.5 })}                       | ${['thresholds', 'persistence']} | ${FRACTIONAL_NUMBER}
  `('refuses $scenario', ({ block, path, message }) => {
    expect(cciStrategySchema.safeParse(block).error?.issues).toMatchObject([{ path, message }]);
  });
});
