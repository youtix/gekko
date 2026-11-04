import { omit } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import { tmaStrategySchema } from './tma.schema';
import {
  ABOVE_ZERO,
  FRACTIONAL_NUMBER,
  INFINITE_NUMBER,
  misspeltIssues,
  QUOTED_NUMBER,
  UNKNOWN_SOURCE,
  unknownKey,
} from './strategySchema.mock';

// The example of the guide (documentation/built-in-strategies.md), without the name that labels the run: the StrategyManager parses the
// block without it
const params = { short: 10, medium: 21, long: 50, src: 'close' };

const NOT_INCREASING =
  'short, medium and long must increase, short < medium < long (swapped periods give the opposite signal, equal ones none)';

describe('tmaStrategySchema', () => {
  it.each`
    scenario                                    | block                                          | expected
    ${'the example of the guide'}               | ${params}                                      | ${params}
    ${'a block without src, on the close'}      | ${omit(params, 'src')}                         | ${params}
    ${'a source of the SMAs besides the close'} | ${{ ...params, src: 'ohlc4' }}                 | ${{ ...params, src: 'ohlc4' }}
    ${'periods of 1, 2 and 3, the smallest'}    | ${{ ...params, short: 1, medium: 2, long: 3 }} | ${{ ...params, short: 1, medium: 2, long: 3 }}
  `('accepts $scenario', ({ block, expected }) => {
    expect(tmaStrategySchema.parse(block)).toEqual(expected);
  });

  // Unchecked, a misspelt short (shrt) left the short SMA on the indicator's default period, 30
  it('refuses a misspelt short (shrt), naming the parameter missing and the key unknown', () => {
    expect(tmaStrategySchema.safeParse({ ...omit(params, 'short'), shrt: 10 }).error?.issues).toMatchObject(
      misspeltIssues(['short'], 'shrt'),
    );
  });

  // The uptrend is short > medium > long: swapped periods bought on the opposite alignment, and two equal ones never aligned. A period of
  // 0 is refused once, by its bound alone: the comparison of the periods leaves it out.
  it.each`
    scenario                                            | block                                        | path          | message
    ${'swapped periods (50, 21, 10)'}                   | ${{ ...params, short: 50, long: 10 }}        | ${[]}         | ${NOT_INCREASING}
    ${'a short above the medium'}                       | ${{ ...params, short: 30 }}                  | ${[]}         | ${NOT_INCREASING}
    ${'a short equal to the medium'}                    | ${{ ...params, short: 21 }}                  | ${[]}         | ${NOT_INCREASING}
    ${'a medium equal to the long'}                     | ${{ ...params, medium: 50 }}                 | ${[]}         | ${NOT_INCREASING}
    ${'a medium above the long'}                        | ${{ ...params, medium: 60 }}                 | ${[]}         | ${NOT_INCREASING}
    ${'a short of 0'}                                   | ${{ ...params, short: 0 }}                   | ${['short']}  | ${ABOVE_ZERO}
    ${'a long of 0, under the medium'}                  | ${{ ...params, long: 0 }}                    | ${['long']}   | ${ABOVE_ZERO}
    ${'a quoted medium'}                                | ${{ ...params, medium: '21' }}               | ${['medium']} | ${QUOTED_NUMBER}
    ${'a fractional long'}                              | ${{ ...params, long: 50.5 }}                 | ${['long']}   | ${FRACTIONAL_NUMBER}
    ${'an infinite long'}                               | ${{ ...params, long: Infinity }}             | ${['long']}   | ${INFINITE_NUMBER}
    ${'an unknown source'}                              | ${{ ...params, src: 'hlc4' }}                | ${['src']}    | ${UNKNOWN_SOURCE}
    ${'a misspelt src (source), not left to the close'} | ${{ ...omit(params, 'src'), source: 'hl2' }} | ${[]}         | ${unknownKey('source')}
  `('refuses $scenario', ({ block, path, message }) => {
    expect(tmaStrategySchema.safeParse(block).error?.issues).toMatchObject([{ path, message }]);
  });
});
