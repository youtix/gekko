import { omit } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { macdStrategySchema } from './macd.schema';
import {
  ABOVE_ZERO,
  AT_LEAST_ZERO,
  FRACTIONAL_NUMBER,
  INFINITE_NUMBER,
  misspeltIssues,
  missing,
  QUOTED_NUMBER,
  unknownKey,
} from './strategySchema.mock';

// The example of the guide (documentation/built-in-strategies.md), without the name that labels the run: the StrategyManager parses the
// block without it
const params = { short: 12, long: 26, signal: 9, macdSrc: 'hist', thresholds: { up: 0, down: 0, persistence: 1 } };
const withThresholds = (thresholds: Record<string, unknown>) => ({ ...params, thresholds: { ...params.thresholds, ...thresholds } });

const SWAPPED_PERIODS = 'short must be below long (swapped periods give the opposite MACD, equal ones a MACD of 0)';
const SIGNAL_OF_ONE_ON_HIST =
  'signal must be at least 2 with macdSrc: hist (a signal of 1 makes the signal line the MACD line itself, and the histogram 0)';
const UNKNOWN_MACD_SRC = 'Invalid option: expected one of "macd"|"signal"|"hist"';

describe('macdStrategySchema', () => {
  // A signal of 1 is refused with the histogram only: the MACD line, which the signal line then equals, still moves
  it.each`
    scenario                                                  | block
    ${'the example of the guide'}                             | ${params}
    ${'macdSrc: macd, the MACD line'}                         | ${{ ...params, macdSrc: 'macd' }}
    ${'macdSrc: signal, the signal line'}                     | ${{ ...params, macdSrc: 'signal' }}
    ${'a signal of 1 with macdSrc: macd'}                     | ${{ ...params, signal: 1, macdSrc: 'macd' }}
    ${'a signal of 1 with macdSrc: signal'}                   | ${{ ...params, signal: 1, macdSrc: 'signal' }}
    ${'a signal of 2 with macdSrc: hist'}                     | ${{ ...params, signal: 2 }}
    ${'periods of 1 and 2, the smallest'}                     | ${{ ...params, short: 1, long: 2 }}
    ${'thresholds the wrong way round, which nothing checks'} | ${withThresholds({ up: -1, down: 1 })}
  `('accepts $scenario as it is', ({ block }) => {
    expect(macdStrategySchema.parse(block)).toEqual(block);
  });

  it('refuses a misspelt persistence (persistance), naming the parameter missing and the key unknown', () => {
    expect(macdStrategySchema.safeParse({ ...params, thresholds: { up: 0, down: 0, persistance: 1 } }).error?.issues).toMatchObject(
      misspeltIssues(['thresholds', 'persistence'], 'persistance'),
    );
  });

  // Unchecked, macdSrc: histogram read a field the MACD does not have, and the strategy never traded. A period below 1 is refused once,
  // by its bound alone: the comparison of the periods leaves it out, so that a long of 0 is not also reported as below a short of 30.
  it.each`
    scenario                                                    | block                                   | path                             | message
    ${'a src, which the MACD strategy does not take'}           | ${{ ...params, src: 'close' }}          | ${[]}                            | ${unknownKey('src')}
    ${'an unknown macdSrc (histogram)'}                         | ${{ ...params, macdSrc: 'histogram' }}  | ${['macdSrc']}                   | ${UNKNOWN_MACD_SRC}
    ${'a missing macdSrc'}                                      | ${omit(params, 'macdSrc')}              | ${['macdSrc']}                   | ${UNKNOWN_MACD_SRC}
    ${'a missing signal'}                                       | ${omit(params, 'signal')}               | ${['signal']}                    | ${missing('number')}
    ${'a quoted signal'}                                        | ${{ ...params, signal: '9' }}           | ${['signal']}                    | ${QUOTED_NUMBER}
    ${'a fractional long'}                                      | ${{ ...params, long: 26.5 }}            | ${['long']}                      | ${FRACTIONAL_NUMBER}
    ${'a short of 0'}                                           | ${{ ...params, short: 0 }}              | ${['short']}                     | ${ABOVE_ZERO}
    ${'a long of 0, under a short of 30'}                       | ${{ ...params, short: 30, long: 0 }}    | ${['long']}                      | ${ABOVE_ZERO}
    ${'a signal of 0 with macdSrc: hist'}                       | ${{ ...params, signal: 0 }}             | ${['signal']}                    | ${ABOVE_ZERO}
    ${'swapped periods (short 26, long 12)'}                    | ${{ ...params, short: 26, long: 12 }}   | ${[]}                            | ${SWAPPED_PERIODS}
    ${'equal periods, whose MACD is 0'}                         | ${{ ...params, short: 26, long: 26 }}   | ${[]}                            | ${SWAPPED_PERIODS}
    ${'a signal of 1 with macdSrc: hist, whose histogram is 0'} | ${{ ...params, signal: 1 }}             | ${[]}                            | ${SIGNAL_OF_ONE_ON_HIST}
    ${'a missing thresholds block'}                             | ${omit(params, 'thresholds')}           | ${['thresholds']}                | ${missing('object')}
    ${'an infinite threshold'}                                  | ${withThresholds({ up: Infinity })}     | ${['thresholds', 'up']}          | ${INFINITE_NUMBER}
    ${'a quoted threshold'}                                     | ${withThresholds({ down: '0' })}        | ${['thresholds', 'down']}        | ${QUOTED_NUMBER}
    ${'a negative persistence'}                                 | ${withThresholds({ persistence: -1 })}  | ${['thresholds', 'persistence']} | ${AT_LEAST_ZERO}
    ${'a fractional persistence'}                               | ${withThresholds({ persistence: 0.5 })} | ${['thresholds', 'persistence']} | ${FRACTIONAL_NUMBER}
  `('refuses $scenario', ({ block, path, message }) => {
    expect(macdStrategySchema.safeParse(block).error?.issues).toMatchObject([{ path, message }]);
  });

  // Each check reports on its own, so that a block with both mistakes is refused with both at once
  it('reports a signal of 1 with macdSrc: hist besides swapped periods', () => {
    expect(macdStrategySchema.safeParse({ ...params, short: 26, long: 12, signal: 1 }).error?.issues).toMatchObject([
      { code: 'custom', path: [], message: SWAPPED_PERIODS },
      { code: 'custom', path: [], message: SIGNAL_OF_ONE_ON_HIST },
    ]);
  });

  // The guide quotes this refusal under the StrategyManager's header, which names the strategy
  it('lists a signal of 1 with macdSrc: hist as the guide quotes it', () => {
    const { error } = macdStrategySchema.safeParse({ ...params, signal: 1 });
    expect(error && z.prettifyError(error)).toBe(`✖ ${SIGNAL_OF_ONE_ON_HIST}`);
  });
});
